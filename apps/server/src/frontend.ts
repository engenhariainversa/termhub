import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import type { Repositories } from './db/repositories/index.js';
import { cityMetaFor, renderCityDocument, renderCityPage } from './public/city-page.js';
import { sendError } from './lib/errors.js';

/** Where the two web bundles are built to: `npm run build` and `npm run build:city` (apps/web). */
export function defaultFrontendDirs(rootDir: string): { webDist: string; cityDist: string } {
  return { webDist: path.join(rootDir, 'apps', 'web', 'dist'), cityDist: path.join(rootDir, 'apps', 'web', 'dist-city') };
}

/** The city bundle's document; the one file whose name the city's own vite config decides. */
export const CITY_INDEX = 'index-city.html';

/**
 * Serves the built frontends: the private app at `/`, the public city at `/city/*`. The two bundles
 * are separate on purpose (the city's must never contain the app), so this wiring is the one place a
 * mistake would quietly serve the private app's `index.html` at a public city address — see
 * frontend.test.ts. Returns false when neither bundle exists (API-only).
 */
export async function registerFrontend(
  fastify: FastifyInstance,
  deps: { repos: Repositories; webDist: string; cityDist: string; publicCityUrl: string },
): Promise<boolean> {
  const cityIndexPath = path.join(deps.cityDist, CITY_INDEX);
  const hasApp = fs.existsSync(path.join(deps.webDist, 'index.html'));
  const hasCity = fs.existsSync(cityIndexPath);
  if (!hasApp && !hasCity) return false;

  if (hasApp) {
    await fastify.register(fastifyStatic, { root: deps.webDist, prefix: '/', index: ['index.html'] });
  }
  if (hasCity) {
    // A second static root beside the app's: `decorateReply: false` because only one plugin
    // instance may add the `sendFile` decorator, and the city document below is never sent
    // through it anyway — it is built fresh from `cityTemplate` on every request.
    await fastify.register(fastifyStatic, { root: deps.cityDist, prefix: '/city/', index: false, decorateReply: false });
  }

  const cityTemplate = hasCity ? fs.readFileSync(cityIndexPath, 'utf8') : null;
  // SPA fallback: a non-API, non-ws, non-mcp route that matched no static file falls here.
  // `/city/*` gets dist-city's own document, its title and Open Graph tags set for the depth the
  // URL points at (public/city-page.ts); every other route gets the app's own.
  fastify.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/') || request.url.startsWith('/mcp')) {
      return sendError(request, reply, 404, 'Não encontrado');
    }
    if (request.url.startsWith('/city/')) {
      if (!cityTemplate) return sendError(request, reply, 404, 'Não encontrado');
      try {
        const html = await renderCityPage(deps.repos, cityTemplate, request.url, deps.publicCityUrl);
        // Short: an unpublished room must drop out of link previews soon, and the memo behind this
        // (public/read.ts) already absorbs the burst of one click or one unfurl.
        reply.header('cache-control', 'public, max-age=5');
        return reply.type('text/html').send(html);
      } catch (err) {
        // The database is down, say: this is still an HTML route, so the visitor gets the neutral
        // city document (its own script then shows the error), never a JSON error body.
        request.log.warn({ err: (err as Error).message }, 'public city: document render failed');
        reply.header('cache-control', 'no-store');
        return reply.code(503).type('text/html').send(renderCityDocument(cityTemplate, cityMetaFor(undefined, {}, deps.publicCityUrl)));
      }
    }
    if (!hasApp) return sendError(request, reply, 404, 'Não encontrado');
    return reply.sendFile('index.html');
  });
  return true;
}
