import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { applyErrorHandler } from '../lib/errors.js';

// Same gating style as agent/e2e.test.ts and start-agent.e2e.test.ts: a Docker runner without
// librsvg installed still passes green, proving the fallback itself works rather than failing on a
// missing binary.
const hasRsvg = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v rsvg-convert'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// The public read must never trigger an ssh round-trip: it only ever consults the memo
// (`cachedTmuxProbe`, synchronous) and must never call the probing function that would refresh it.
const probingFn = vi.fn(async () => {
  throw new Error('probeTmuxSessionsCached must never be called from the public read');
});
let cached: { reachable: boolean; sessions: Set<string> } | undefined = { reachable: true, sessions: new Set(['th-t1']) };
const cachedFn = vi.fn(() => cached);
vi.mock('../terminal/machine-exec.js', () => ({
  probeTmuxSessionsCached: (...a: unknown[]) => probingFn(...a),
  cachedTmuxProbe: (...a: unknown[]) => cachedFn(...a),
}));

// A spy around the real renderCard (not a replacement): the "with a real rsvg-convert" tests below
// still need the genuine subprocess to prove a real PNG comes back, but the cache tests need to
// count how many times rasterising actually happened, which the response body alone can't show.
const { renderCardSpy } = vi.hoisted(() => ({ renderCardSpy: vi.fn() }));
vi.mock('../public/card.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../public/card.js')>();
  return {
    ...actual,
    renderCard: async (svg: string) => {
      renderCardSpy();
      return actual.renderCard(svg);
    },
  };
});

const { publicCityRoutes } = await import('./public-city.js');
const { clearPublicCityMemo } = await import('../public/read.js');

const MACHINES = [
  { id: 'm1', name: 'Jarvis Office', owner_id: 'u1' },
  { id: 'm2', name: 'Empty HQ', owner_id: 'u2' },
  { id: 'm3', name: 'Rival HQ', owner_id: 'u3' },
  { id: 'm4', name: 'Terceiro HQ', owner_id: 'u4' },
  { id: 'm5', name: 'Quarto HQ', owner_id: 'u5' },
];

const PROJECTS: { id: string; owner_id: string; name: string; status: string; is_public: boolean }[] = [
  { id: 'p1', owner_id: 'u1', name: 'Engage Easy', status: 'active', is_public: true },
  { id: 'p2', owner_id: 'u1', name: 'Projeto Secreto', status: 'active', is_public: false },
  { id: 'p3', owner_id: 'u1', name: 'Projeto Arquivado', status: 'archived', is_public: true },
  { id: 'p4', owner_id: 'u3', name: 'Rival Room', status: 'active', is_public: true },
  { id: 'p5', owner_id: 'u4', name: 'Sala do Terceiro', status: 'active', is_public: true },
  { id: 'p6', owner_id: 'u5', name: 'Sala do Quarto', status: 'active', is_public: true },
];

type TabRow = { id: string; project_id: string; machine_id: string; name: string; kind: string; tmux_session: string | null; simulator_udid: string | null; state: string | null };
const TABS: TabRow[] = [
  { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'shell', kind: 'terminal', tmux_session: 'th-t1', simulator_udid: null, state: 'working' },
  { id: 't9', project_id: 'p1', machine_id: 'm3', name: 'shell na maquina alheia', kind: 'terminal', tmux_session: 'th-t9', simulator_udid: null, state: 'working' },
  { id: 't2', project_id: 'p2', machine_id: 'm1', name: 'segredo', kind: 'terminal', tmux_session: 'th-t2', simulator_udid: null, state: 'working' },
  { id: 't4', project_id: 'p4', machine_id: 'm3', name: 'rival shell', kind: 'terminal', tmux_session: 'th-t4', simulator_udid: null, state: 'working' },
  { id: 't5', project_id: 'p5', machine_id: 'm4', name: 'terceira shell', kind: 'terminal', tmux_session: 'th-t5', simulator_udid: null, state: 'working' },
  { id: 't6', project_id: 'p6', machine_id: 'm5', name: 'quarta shell', kind: 'terminal', tmux_session: 'th-t6', simulator_udid: null, state: 'working' },
];

/** The public route with stubbed repositories, built the way office.test.ts builds its app. */
function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  const repos = {
    users: {
      findByNickname: vi.fn(async (nickname: string) =>
        nickname === 'pedro'
          ? { id: 'u1', name: 'Pedro', city_short_url_partner: 'https://77a.it/pedro', city_short_url_custom: null }
          : nickname === 'semnada'
            ? { id: 'u2', name: 'Semnada' }
            : nickname === 'terceiro'
              ? { id: 'u4', name: 'Terceiro' }
              : nickname === 'quarto'
                ? { id: 'u5', name: 'Quarto' }
                : undefined,
      ),
    },
    machines: {
      // A real repository already scopes by owner (see machines.ts: `list(owner: OwnerScope)`).
      // Returning every machine here and letting the mock filter by the argument the same way the
      // real query does is what makes the "another owner's machine" test meaningful: it fails the
      // moment `readPublicCity` stops passing `owner.id` through.
      list: vi.fn(async (ownerId?: string | null) => MACHINES.filter((m) => m.owner_id === ownerId)),
    },
    projects: {
      list: vi.fn(async ({ owner }: { owner: string }) => PROJECTS.filter((p) => p.owner_id === owner)),
    },
    tabs: {
      listByProjects: vi.fn(async (projectIds: string[]) => TABS.filter((t) => projectIds.includes(t.project_id))),
    },
  } as unknown as Repositories;
  app.register((instance) => publicCityRoutes(instance, repos), { prefix: '/public' });
  return { app, repos };
}

describe('GET /public/city/:nickname', () => {
  beforeEach(() => {
    cached = { reachable: true, sessions: new Set(['th-t1']) };
    clearPublicCityMemo();
    probingFn.mockClear();
    cachedFn.mockClear();
  });

  it('carries the owner’s effective short link, and null for a city without one', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json().short_url).toBe('https://77a.it/pedro');
    expect((await app.inject({ method: 'GET', url: '/public/city/terceiro' })).json().short_url).toBeNull();
  });

  it('answers the city of a nickname that has a public project', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nickname).toBe('pedro');
    expect(res.json().buildings.map((b: { name: string }) => b.name)).toEqual(['Engage Easy']);
  });

  it('leaves out a private project', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Secreto');
  });

  it('leaves out an archived project even though it is public', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Projeto Arquivado');
  });

  it('never asks for a private project\'s tabs — asserted on the repository call, not only on the body', async () => {
    const { app, repos } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    // p2 (private) and p3 (archived) must never appear in the argument, not just in the response
    expect(repos.tabs.listByProjects).toHaveBeenCalledTimes(1);
    expect(repos.tabs.listByProjects).toHaveBeenCalledWith(['p1']);
  });

  it('leaves out somebody else\'s published project', async () => {
    const { app } = buildApp();
    const body = JSON.stringify((await app.inject({ method: 'GET', url: '/public/city/pedro' })).json());
    expect(body).not.toContain('Rival Room');
    expect(body).not.toContain('Rival HQ');
  });

  // p1 is published and runs on m3 too, a machine u3 owns: its robot there is not pedro's to publish,
  // and no machine — not even pedro's own m1 — is named anywhere
  it('never exposes a robot on a machine the owner does not own, nor any machine name', async () => {
    const { app } = buildApp();
    const city = (await app.inject({ method: 'GET', url: '/public/city/pedro' })).json();
    expect(city.buildings).toHaveLength(1);
    expect(city.buildings[0].name).toBe('Engage Easy');
    expect(city.buildings[0].robots.map((r: { name: string }) => r.name)).toEqual(['shell']);
    const body = JSON.stringify(city);
    for (const secret of ['Rival HQ', 'shell na maquina alheia', 'Jarvis Office']) expect(body).not.toContain(secret);
  });

  // city-by-project §2.4: a published project is a building even with no agent of the owner's own
  it("shows a published project whose agents all run on somebody else's machine as an empty building", async () => {
    const { app } = buildApp();
    PROJECTS.push({ id: 'p7', owner_id: 'u2', name: 'Sem Agentes Proprios', status: 'active', is_public: true });
    TABS.push({ id: 't7', project_id: 'p7', machine_id: 'm3', name: 'aba na maquina de outro', kind: 'terminal', tmux_session: 'th-t7', simulator_udid: null, state: 'working' });
    try {
      const res = await app.inject({ method: 'GET', url: '/public/city/semnada' });
      expect(res.statusCode).toBe(200);
      expect(res.json().buildings).toEqual([expect.objectContaining({ name: 'Sem Agentes Proprios', robots: [] })]);
      expect(res.body).not.toContain('aba na maquina de outro');
    } finally {
      PROJECTS.pop();
      TABS.pop();
    }
  });

  it('404s an unknown nickname', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/ninguem' })).statusCode).toBe(404);
  });

  it('404s a nickname that exists but published nothing — an empty city would confirm the name', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: '/public/city/semnada' })).statusCode).toBe(404);
  });

  it('404s a nickname longer than normalizeNickname allows, the same as any other bad nickname', async () => {
    const { app } = buildApp();
    expect((await app.inject({ method: 'GET', url: `/public/city/${'a'.repeat(65)}` })).statusCode).toBe(404);
  });

  it('never calls the network-triggering probe — only ever reads the memo', async () => {
    const { app } = buildApp();
    await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(probingFn).not.toHaveBeenCalled();
    expect(cachedFn).toHaveBeenCalled();
  });

  it('performs no probe at all with a cold memo, and still answers with its robots', async () => {
    cached = undefined;
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro' });
    expect(res.statusCode).toBe(200);
    expect(probingFn).not.toHaveBeenCalled();
    const robots = res.json().buildings[0].robots;
    expect(robots).toHaveLength(1);
    // cold memo: alive falls back to the tool's own reported state, not an empty-office read
    expect(robots[0].alive).toBe(true);
  });

  it('answers a burst of reads for the same city from one database read', async () => {
    const { app, repos } = buildApp();
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: 'GET', url: '/public/city/pedro' })).statusCode).toBe(200);
    expect(repos.users.findByNickname).toHaveBeenCalledTimes(1);
  });
});

describe('GET /public/city/:nickname/card.png', () => {
  beforeEach(() => {
    cached = { reachable: true, sessions: new Set(['th-t1']) };
    clearPublicCityMemo();
    renderCardSpy.mockClear();
  });

  it('falls back to the landing card for a nickname that does not exist', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/ninguem/card.png' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/og-image.png');
  });

  it('falls back to the landing card for a nickname that published nothing', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/semnada/card.png' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/og-image.png');
  });

  it('falls back to the landing card, not a 400, for an oversized or repeated ?building=', async () => {
    const { app } = buildApp();
    for (const url of [`/public/city/pedro/card.png?building=${'x'.repeat(65)}`, '/public/city/pedro/card.png?building=a&building=b']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/og-image.png');
    }
  });

  // city-by-project §2.5: the card takes `?building=` only; a `?room=` of an old link is not read
  it('does not read a ?room= at all, however it is written', async () => {
    vi.stubEnv('TERMHUB_RSVG_BIN', '/nonexistent/rsvg-convert');
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: `/public/city/pedro/card.png?room=${'x'.repeat(65)}&room=y` });
    vi.unstubAllEnvs();
    // the city read and the rasteriser were reached (the fallback here is the missing binary's), not a query refusal
    expect(res.statusCode).toBe(302);
    expect(renderCardSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the landing card when the rasteriser is unavailable', async () => {
    vi.stubEnv('TERMHUB_RSVG_BIN', '/nonexistent/rsvg-convert');
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/public/city/pedro/card.png' });
    vi.unstubAllEnvs();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/og-image.png');
  });

  describe.skipIf(!hasRsvg)('with a real rsvg-convert on PATH', () => {
    it('renders a PNG for a published city', async () => {
      const { app } = buildApp();
      const res = await app.inject({ method: 'GET', url: '/public/city/pedro/card.png' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });

    it('serves the second request for the same card from cache, without rasterising again', async () => {
      // A nickname of its own, never requested by any other test in this file, so the cache is
      // guaranteed cold going in regardless of test order.
      const url = '/public/city/terceiro/card.png';
      const { app } = buildApp();
      const first = await app.inject({ method: 'GET', url });
      expect(first.statusCode).toBe(200);
      expect(renderCardSpy).toHaveBeenCalledTimes(1);
      const second = await app.inject({ method: 'GET', url });
      expect(second.statusCode).toBe(200);
      expect(second.rawPayload).toEqual(first.rawPayload);
      expect(renderCardSpy).toHaveBeenCalledTimes(1);
    });

    it('collapses two different unresolved ?building= ids onto the same cached city-level card, rendering once', async () => {
      // Same isolation concern as above: a nickname this test alone touches.
      const { app } = buildApp();
      const first = await app.inject({ method: 'GET', url: '/public/city/quarto/card.png?building=not-a-real-id-one' });
      const second = await app.inject({ method: 'GET', url: '/public/city/quarto/card.png?building=not-a-real-id-two' });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.rawPayload).toEqual(first.rawPayload);
      expect(renderCardSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('GET /public/legal', () => {
  it("serves the instance's legal footer, null where it has none", async () => {
    const { config } = await import('../config.js');
    const saved = { ...config.legal };
    try {
      Object.assign(config.legal, { termsUrl: null, privacyUrl: null, entity: null });
      const none = await buildApp().app.inject({ method: 'GET', url: '/public/legal' });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ terms_url: null, privacy_url: null, legal_entity: null });

      Object.assign(config.legal, { termsUrl: 'https://termhub.dev/termos/', privacyUrl: 'https://termhub.dev/privacidade/', entity: '8020 Digital Ltda · CNPJ 32.285.763/0001-12' });
      const set = await buildApp().app.inject({ method: 'GET', url: '/public/legal' });
      expect(set.json()).toEqual({ terms_url: 'https://termhub.dev/termos/', privacy_url: 'https://termhub.dev/privacidade/', legal_entity: '8020 Digital Ltda · CNPJ 32.285.763/0001-12' });
    } finally {
      Object.assign(config.legal, saved);
    }
  });
});
