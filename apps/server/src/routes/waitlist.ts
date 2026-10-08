import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError, notFound } from '../lib/errors.js';

/**
 * Cloud waitlist. POST is public: the landing at termhub.dev posts here through the proxy
 * (nginx forwards termhub.dev/api/waitlist to the app), so no CORS and no Cloudflare Access
 * in the way. GET/DELETE are for the app's Waitlist tab.
 * GET/DELETE are guarded by the "waitlist" resource (admins and roles granted it).
 */

const digits = (max: number) => z.string().trim().regex(/^\d+$/, 'only digits').max(max);

/** Exported for the unit test: the public form's payload contract. */
export const signupBody = z.object({
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  // the address is added to Cloudflare Access, and Access signs people in with Google,
  // so only Gmail addresses can be invited
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ message: 'invalid_email' })
    .max(200)
    .refine((e) => /^[^@\s]+@gmail\.com$/i.test(e), { message: 'gmail_only' }),
  phone_country: digits(4).transform((s) => s.replace(/^0+/, '')).refine((s) => s.length >= 1, 'required'),
  phone_area: digits(5),
  phone_number: digits(12).refine((s) => s.length >= 6, 'too short'),
  linkedin: z.string().trim().max(200).optional().nullable(),
  github: z.string().trim().max(200).optional().nullable(),
  locale: z.enum(['pt', 'en', 'es']).default('pt'),
  /** honeypot: real users never fill it */
  website: z.string().max(0).optional(),
});

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * Parses the public form's payload, turning the two e-mail rules into stable codes
 * (`gmail_only`, `invalid_email`) that the landing maps to its own message; every other
 * field keeps the generic zod 400.
 */
export function parseSignup(body: unknown) {
  const parsed = signupBody.safeParse(body);
  if (parsed.success) return parsed.data;
  const email = parsed.error.issues.find((issue) => issue.path[0] === 'email');
  if (email?.message === 'gmail_only') throw new HttpError(400, 'Use um endereço @gmail.com', 'gmail_only');
  if (email) throw new HttpError(400, 'E-mail inválido', 'invalid_email');
  throw parsed.error;
}

/** "handle" or URL -> canonical profile URL; empty -> null. */
function profileUrl(value: string | null | undefined, base: string, handleRe: RegExp): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '').replace(/\/+$/, '');
  if (!handleRe.test(handle)) throw new HttpError(400, 'Invalid profile', 'VALIDATION');
  return `${base}${handle}`;
}

/**
 * Tiny in-memory rate limit for the public form, per IP per hour: raw attempts (including
 * invalid ones) and successful sign-ups are counted separately so a typo does not lock
 * someone out, while a bot cannot hammer the endpoint either.
 */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 30;
const MAX_SIGNUPS = 5;
const attempts = new Map<string, number[]>();
const signups = new Map<string, number[]>();
function bump(map: Map<string, number[]>, ip: string, max: number, record: boolean): boolean {
  const now = Date.now();
  const list = (map.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= max) return false;
  if (record) list.push(now);
  map.set(ip, list);
  if (map.size > 10_000) map.clear();
  return true;
}

export async function waitlistRoutes(app: FastifyInstance, repos: Repositories) {
  app.post('/', { config: { public: true } }, async (request, reply) => {
    const tooMany = () => new HttpError(429, 'Too many sign-ups from this address; try again later', 'RATE_LIMITED');
    if (!bump(attempts, request.ip, MAX_ATTEMPTS, true) || !bump(signups, request.ip, MAX_SIGNUPS, false)) throw tooMany();
    const b = parseSignup(request.body);
    const linkedin = profileUrl(b.linkedin, 'https://www.linkedin.com/in/', /^[A-Za-z0-9._-]{2,100}$/);
    const github = profileUrl(b.github, 'https://github.com/', /^[A-Za-z0-9-]{1,39}$/);
    const existing = await repos.waitlist.findByEmail(b.email);
    if (existing) return reply.code(200).send({ ok: true, already: true });
    if (!bump(signups, request.ip, MAX_SIGNUPS, true)) throw tooMany();
    await repos.waitlist.create({
      first_name: b.first_name, last_name: b.last_name, email: b.email,
      phone_country: b.phone_country, phone_area: b.phone_area, phone_number: b.phone_number,
      phone: `+${b.phone_country}${b.phone_area}${b.phone_number}`,
      linkedin, github, locale: b.locale,
    });
    request.log.info({ locale: b.locale }, 'waitlist sign-up');
    return reply.code(201).send({ ok: true, already: false });
  });

  app.get('/', async () => ({ entries: await repos.waitlist.list() }));

  app.delete('/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    if (!(await repos.waitlist.delete(id))) throw notFound('Entry not found');
    return { ok: true };
  });
}
