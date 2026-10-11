import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized, sendError } from '../lib/errors.js';
import { effectiveShortUrl, type ShortLinkService } from '../public/short-link.js';

const customBody = z.object({ short_url: z.string().trim().min(1).max(300) });

/**
 * The signed-in person's city short link (Settings → Minha cidade). Authenticated, no resource
 * grant, like /me/nickname: every account has a city. Registered under /auth beside authRoutes.
 */
export async function cityLinkRoutes(app: FastifyInstance, deps: { shortLinks: ShortLinkService }) {
  const links = deps.shortLinks;

  app.get('/me/city-link', async (request) => {
    if (!request.user) throw unauthorized();
    let user = request.user;
    // the lazy retry (spec §3.3): a claimed nickname, the key set and no short link yet — one
    // attempt, rate-limited per user inside the service, and shared with a claim still running
    // A saved link keeps showing even if the key is removed later: it still works; the key gates creation and editing only.
    if (links.enabled && user.nickname && !effectiveShortUrl(user)) {
      const partner = await links.ensurePartner(user);
      if (partner) user = { ...user, city_short_url_partner: partner };
    }
    return links.view(user);
  });

  app.put('/me/city-link', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return sendError(request, reply, 404, 'O link curto não está disponível nesta instância', 'SHORT_LINK_DISABLED');
    const nickname = request.user.nickname;
    if (!nickname) return sendError(request, reply, 409, 'Escolha seu apelido antes', 'NICKNAME_REQUIRED');
    const { short_url } = customBody.parse(request.body);
    const out = await links.setCustom(request.user, short_url);
    if (out.ok) {
      request.log.info({ userId: request.user.id }, 'short link: custom link set');
      return links.view(out.user);
    }
    if (out.code === 'SHORT_LINK_INVALID') return sendError(request, reply, 400, 'Use um link no formato https://77a.it/seu-link', out.code);
    if (out.code === 'SHORT_LINK_UNREACHABLE') return sendError(request, reply, 502, 'Não foi possível abrir esse link agora. Tente de novo.', out.code);
    const cityUrl = links.cityUrlOf(nickname);
    const error = out.location
      ? `Esse link leva para ${out.location}, não para a sua cidade (${cityUrl}).`
      : `Esse link não leva para a sua cidade (${cityUrl}).`;
    return reply.code(400).send({ error, code: out.code, location: out.location });
  });

  app.delete('/me/city-link/custom', async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (!links.enabled) return sendError(request, reply, 404, 'O link curto não está disponível nesta instância', 'SHORT_LINK_DISABLED');
    const out = await links.clearCustom(request.user);
    if (!out.ok) {
      return sendError(request, reply, 502, 'Não foi possível criar o link da parceria agora. Seu link curto continua valendo; tente de novo mais tarde.', out.code);
    }
    request.log.info({ userId: request.user.id }, 'short link: custom link cleared');
    return links.view(out.user);
  });
}
