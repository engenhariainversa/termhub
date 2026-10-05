import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Repositories } from '../db/repositories/index.js';
import { buildCardSvg, renderCard, resolveFocus } from '../public/card.js';
import { normalizeNickname } from '../public/nickname.js';
import { readPublicCityCached } from '../public/read.js';
import { sendError } from '../lib/errors.js';

// No length cap here: `normalizeNickname` is the only judge of shape (it is strictly stricter,
// 3-30 characters), so a too-long segment lands on the same 404 as any other bad nickname instead
// of a distinguishable 400.
const params = z.object({ nickname: z.string().min(1) });

// `building` is a public (obfuscated) id from PublicCity, 22 base64url characters; the cap is a
// generous safety limit, not a shape check — an id that matches nothing (a stale one, or a machine
// id from the links of the city by machine) renders the city-level card (see buildCardSvg's own
// resolution). A `?room=` from those old links is not read at all. A query that does not fit (an
// oversized id, a repeated parameter) falls back to the landing card like every other malformed
// input on this route, never a 400 with validation details.
const cardQuery = z.object({ building: z.string().max(64).optional() });

/** Falls back to the landing's own card: a link that shows the product's image beats one that shows a broken one. */
const FALLBACK_CARD = '/og-image.png';

const CARD_CACHE_MS = 5 * 60 * 1000;

// A generous bound: this instance's own published cities plus their buildings are the only
// keys that will ever actually be requested for real, and none of that should approach four figures.
// It exists purely so a determined caller mining random ?building= values can't grow the map
// forever — see the note on the key below for why it can't do that by minting new entries either.
const CARD_CACHE_MAX_ENTRIES = 500;

/**
 * The rendered card, cached in-process for a few minutes per nickname+resolved-depth: a crawler
 * unfurling a link fetches the same card several times in a row, and rasterising is the one real
 * cost on this whole anonymous surface. Never caches a fallback — those are just a redirect, not
 * worth the shelf space, and caching a miss would keep a newly published city's first card looking
 * stale.
 *
 * The key is built from the *resolved* building (its real public id, once matched against
 * the city just read), never from the raw query string: `cardQuery` accepts any string and an id
 * that matches nothing silently falls back to the city-level card, so keying on the raw value would
 * let a caller mint one cache entry — one DB read, one `rsvg-convert` spawn — per garbage id it
 * feels like sending, unbounded and unrated. Keyed on what it resolved to, every garbage id for the
 * same nickname collapses onto the one city-level entry that a real visitor would also hit.
 */
const cardCache = new Map<string, { png: Buffer; expiresAt: number }>();

/** Dropped whenever the cache is touched (read or write), so an idle entry never outlives its TTL. */
function sweepExpiredCards(now: number): void {
  for (const [key, entry] of cardCache) {
    if (entry.expiresAt <= now) cardCache.delete(key);
  }
}

function cachedCard(key: string): Buffer | undefined {
  const now = Date.now();
  sweepExpiredCards(now);
  const hit = cardCache.get(key);
  return hit && hit.expiresAt > now ? hit.png : undefined;
}

function setCachedCard(key: string, png: Buffer): void {
  sweepExpiredCards(Date.now());
  if (!cardCache.has(key) && cardCache.size >= CARD_CACHE_MAX_ENTRIES) {
    // Map iterates in insertion order: the first key is the oldest surviving entry. A crude FIFO
    // eviction is enough — this cap exists to bound memory, not to optimise a hit rate.
    const oldest = cardCache.keys().next().value;
    if (oldest !== undefined) cardCache.delete(oldest);
  }
  cardCache.set(key, { png, expiresAt: Date.now() + CARD_CACHE_MS });
}

/** The cache key for a nickname at a resolved depth: an unresolved id folds onto the same key as no id at all. */
function cardCacheKey(nickname: string, focus: { building?: { id: string } }): string {
  return `${nickname}:${focus.building?.id ?? ''}`;
}

/**
 * The public city, read by anyone with the link. No session, no Access: this lives on the landing
 * host. A nickname that does not exist and one that published nothing answer the same 404 — an empty
 * city would tell a stranger which nicknames are taken.
 */
export async function publicCityRoutes(app: FastifyInstance, repos: Repositories) {
  app.get('/city/:nickname', { config: { public: true } }, async (request, reply) => {
    const parsed = normalizeNickname(params.parse(request.params).nickname);
    if (!parsed.ok) return sendError(request, reply, 404, 'Cidade não encontrada', 'NOT_FOUND');
    const city = await readPublicCityCached(repos, parsed.value);
    if (!city) return sendError(request, reply, 404, 'Cidade não encontrada', 'NOT_FOUND');
    request.log.debug({ nickname: parsed.value, buildings: city.buildings.length }, 'public city: snapshot');
    reply.header('cache-control', 'public, max-age=5');
    return city;
  });

  /**
   * The link preview card (Open Graph / Twitter image): what a pasted `/city/@<nickname>` link
   * shows before anyone clicks. A nickname that does not exist, a city with nothing published, and
   * a server that cannot rasterise all fall back to the same PNG the landing already serves.
   */
  app.get('/city/:nickname/card.png', { config: { public: true } }, async (request, reply) => {
    const parsed = normalizeNickname(params.parse(request.params).nickname);
    if (!parsed.ok) return reply.redirect(FALLBACK_CARD, 302);
    const query = cardQuery.safeParse(request.query);
    if (!query.success) return reply.redirect(FALLBACK_CARD, 302);
    const { building } = query.data;
    const city = await readPublicCityCached(repos, parsed.value);
    if (!city) return reply.redirect(FALLBACK_CARD, 302);
    // Resolved before the cache is ever consulted: an id that matches nothing in this city (or one
    // from a different city, or a stale id after unpublishing) must key exactly like no id at all.
    const focus = resolveFocus(city, { building });
    const cacheKey = cardCacheKey(parsed.value, focus);
    const cached = cachedCard(cacheKey);
    if (cached) {
      reply.header('content-type', 'image/png');
      reply.header('cache-control', 'public, max-age=300');
      return cached;
    }
    const png = await renderCard(buildCardSvg(city, { building }));
    if (!png) return reply.redirect(FALLBACK_CARD, 302);
    setCachedCard(cacheKey, png);
    reply.header('content-type', 'image/png');
    reply.header('cache-control', 'public, max-age=300');
    return png;
  });
}
