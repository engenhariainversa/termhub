import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { LocalizedText, requestLocale, t, tk } from '../i18n/index.js';

/** A message as an error carries it: a pt-BR key, or a `msg()` with values. */
export type Message = string | LocalizedText;

const asLocalized = (m: Message): LocalizedText => (m instanceof LocalizedText ? m : new LocalizedText(m));

/** The translatable form of any error's message: our own errors keep theirs, anything else is its plain text. */
export function localizedOf(err: unknown): LocalizedText {
  if (err && typeof err === 'object' && 'localized' in err && err.localized instanceof LocalizedText) return err.localized;
  return new LocalizedText(err instanceof Error ? err.message : String(err));
}

/**
 * An expected failure with an HTTP status. `message` is the pt-BR rendering (logs and pt-BR tests
 * read it); the reply is translated from `localized` with the request's language.
 */
export class HttpError extends Error {
  /** Non-enumerable, so equality checks on the error (tests, logs) see only code and message. */
  declare readonly localized: LocalizedText;
  constructor(
    public statusCode: number,
    message: Message,
    public code?: string,
  ) {
    const localized = asLocalized(message);
    super(localized.toString());
    Object.defineProperty(this, 'localized', { value: localized, enumerable: false });
  }
}

export const notFound = (message: Message = tk('Não encontrado')) => new HttpError(404, message, 'NOT_FOUND');
export const badRequest = (message: Message = tk('Requisição inválida')) => new HttpError(400, message, 'BAD_REQUEST');
export const unauthorized = (message: Message = tk('Não autenticado')) => new HttpError(401, message, 'UNAUTHORIZED');
export const forbidden = (message: Message = tk('Sem permissão')) => new HttpError(403, message, 'FORBIDDEN');
export const conflict = (message: Message = tk('Conflito')) => new HttpError(409, message, 'CONFLICT');

/** Sends `{ error, code, ...extra }` with `error` translated into the request's language. */
export function sendError(request: FastifyRequest, reply: FastifyReply, status: number, message: Message, code?: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error: t(requestLocale(request), message), code, ...extra });
}

/**
 * The single place that turns thrown errors into the API's wire shape:
 * zod failures become 400 VALIDATION with the issues, HttpError keeps its own
 * status and code, anything else is a 500 with the details swallowed. `error` is
 * translated with the request's language (user → Accept-Language → pt-BR); `code` never changes.
 */
export function applyErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((err, request, reply) => {
    const locale = requestLocale(request);
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: t(locale, 'Dados inválidos'), code: 'VALIDATION', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: t(locale, err.localized), code: err.code });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'erro não tratado');
    return reply.code(status).send({ error: status >= 500 ? t(locale, 'Erro interno') : e.message, code: 'ERROR' });
  });
}
