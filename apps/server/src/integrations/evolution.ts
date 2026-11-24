import { checkPublicUrl } from './public-url.js';

/**
 * TER-1201: the two calls termhub makes to a person's own Evolution API server (v2,
 * https://doc.evolution-api.com): the instance's connection state and a text message.
 *
 * The base URL is the person's, so it goes through `checkPublicUrl` (TER-578) before every request —
 * DNS included — and redirects are never followed: a server cannot bounce termhub into its own network.
 * Errors are codes only, never a piece of the answer body (which could echo the key or a number).
 */

export interface EvolutionTarget {
  server_url: string;
  instance: string;
  api_key: string;
}

export type EvolutionErrorCode = 'URL_REFUSED' | 'UNREACHABLE' | 'TIMEOUT' | 'REDIRECT' | 'AUTH' | 'INSTANCE_NOT_FOUND' | 'NOT_CONNECTED' | 'BAD_NUMBER' | `HTTP_${number}`;

export class EvolutionError extends Error {
  constructor(
    readonly code: EvolutionErrorCode,
    /** For URL_REFUSED: the guard's pt-BR reason (a `tk` key). */
    readonly reason?: string,
  ) {
    super(`Evolution: ${code}`);
  }
}

export type ConnectionState = 'open' | 'connecting' | 'close' | string;

const TIMEOUT_MS = 10_000;

/** The base URL without a trailing slash; a path prefix (https://host/evolution) is kept. */
const baseOf = (url: URL): string => `${url.origin}${url.pathname.replace(/\/+$/, '')}`;

async function call(target: EvolutionTarget, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  const check = await checkPublicUrl(target.server_url);
  if (!check.ok) throw new EvolutionError('URL_REFUSED', check.reason);
  let res: Response;
  try {
    res = await fetchImpl(`${baseOf(check.url)}${path}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { apikey: target.api_key, accept: 'application/json', 'content-type': 'application/json' },
    });
  } catch (e) {
    throw new EvolutionError((e as Error)?.name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE');
  }
  if (res.status >= 300 && res.status < 400) throw new EvolutionError('REDIRECT');
  if (res.status === 401 || res.status === 403) throw new EvolutionError('AUTH');
  if (res.status === 404) throw new EvolutionError('INSTANCE_NOT_FOUND');
  return res;
}

const instancePath = (target: EvolutionTarget) => encodeURIComponent(target.instance);

/** `GET /instance/connectionState/{instance}`: `open` means WhatsApp is paired and sending works. */
export async function connectionState(target: EvolutionTarget, fetchImpl: typeof fetch = fetch): Promise<ConnectionState> {
  const res = await call(target, `/instance/connectionState/${instancePath(target)}`, { method: 'GET' }, fetchImpl);
  if (!res.ok) throw new EvolutionError(`HTTP_${res.status}`);
  const body = (await res.json().catch(() => null)) as { instance?: { state?: unknown }; state?: unknown } | null;
  const state = body?.instance?.state ?? body?.state;
  return typeof state === 'string' ? state : 'unknown';
}

/** `POST /message/sendText/{instance}`: one text to `number` (digits with the country code). */
export async function sendText(target: EvolutionTarget, number: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await call(target, `/message/sendText/${instancePath(target)}`, { method: 'POST', body: JSON.stringify({ number, text }) }, fetchImpl);
  if (res.ok) return;
  // Evolution answers 400 when the number is not on WhatsApp (`exists: false`) or malformed.
  if (res.status === 400) throw new EvolutionError('BAD_NUMBER');
  throw new EvolutionError(`HTTP_${res.status}`);
}
