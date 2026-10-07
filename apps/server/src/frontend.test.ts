import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Repositories } from './db/repositories/index.js';

vi.mock('./terminal/machine-exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminal/machine-exec.js')>()),
  cachedTmuxProbe: () => undefined,
}));

const { CITY_INDEX, defaultFrontendDirs, registerFrontend } = await import('./frontend.js');
const { clearPublicCityMemo } = await import('./public/read.js');

const APP_MARKER = 'PRIVATE-APP-DOCUMENT';
const CITY_MARKER = 'PUBLIC-CITY-DOCUMENT';

/** Two fixture bundles laid out the way `npm run build` and `npm run build:city` lay them out. */
function fixtureDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-frontend-'));
  const webDist = path.join(root, 'dist');
  const cityDist = path.join(root, 'dist-city');
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(cityDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), `<!doctype html><html><head><title>termhub</title></head><body>${APP_MARKER}</body></html>`);
  fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log("app")');
  fs.writeFileSync(path.join(cityDist, CITY_INDEX), `<!doctype html><html><head><title>termhub · cidade</title></head><body>${CITY_MARKER}</body></html>`);
  fs.writeFileSync(path.join(cityDist, 'assets', 'city.js'), 'console.log("city")');
  return { root, webDist, cityDist };
}

const BASE = 'https://th.example.org/city';

function stubRepos(opts: { fail?: boolean } = {}): Repositories {
  return {
    users: {
      findByNickname: vi.fn(async (nickname: string) => {
        if (opts.fail) throw new Error('db down');
        return nickname === 'pedro' ? { id: 'u1', name: 'Pedro' } : undefined;
      }),
    },
    machines: { list: vi.fn(async () => [{ id: 'm1', name: 'Jarvis', owner_id: 'u1' }]) },
    projects: { list: vi.fn(async () => [{ id: 'p1', owner_id: 'u1', name: 'Sala', status: 'active', is_public: true }]) },
    tabs: { listByProjects: vi.fn(async () => []) },
  } as unknown as Repositories;
}

describe('registerFrontend', () => {
  const dirs = fixtureDirs();
  afterAll(() => fs.rmSync(dirs.root, { recursive: true, force: true }));

  async function build(repos = stubRepos()) {
    clearPublicCityMemo();
    const app = Fastify();
    await registerFrontend(app, { repos, webDist: dirs.webDist, cityDist: dirs.cityDist, publicCityUrl: BASE });
    return app;
  }

  // The feature's one silent failure mode: /city/@nick serving the private app's index.html.
  it('serves the city document at /city/@nick, never the private app', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/city/@pedro' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(CITY_MARKER);
    expect(res.body).not.toContain(APP_MARKER);
    expect(res.body).toContain('A cidade de Pedro no termhub');
    expect(res.headers['cache-control']).toBe('public, max-age=5');
  });

  it('serves the city document at a deeper depth too', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/city/@pedro/abc?room=xyz' });
    expect(res.body).toContain(CITY_MARKER);
  });

  it("resolves the city bundle's own assets under /city/", async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/city/assets/city.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("city")');
  });

  it('still serves the private app at / and at its client-side routes', async () => {
    const app = await build();
    for (const url of ['/', '/office', '/projects/p1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(APP_MARKER);
    }
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).body).toBe('console.log("app")');
  });

  // The app's index.html goes out through @fastify/static's sendFile: the CSP hook must still see it as HTML (TER-579).
  it('sends the Content-Security-Policy with the static app document and not with its assets', async () => {
    const { registerSecurityHeaders } = await import('./lib/security-headers.js');
    clearPublicCityMemo();
    const app = Fastify();
    registerSecurityHeaders(app, { publicUrl: 'https://th.example.org' });
    await registerFrontend(app, { repos: stubRepos(), webDist: dirs.webDist, cityDist: dirs.cityDist, publicCityUrl: BASE });
    for (const url of ['/', '/office', '/city/@pedro']) {
      expect((await app.inject({ method: 'GET', url })).headers['content-security-policy']).toContain("script-src 'self'");
    }
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).headers['content-security-policy']).toBeUndefined();
  });

  it('answers an unknown /api/ route with a JSON 404, not a document', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/api/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeTruthy();
  });

  it('answers an HTML document, not a JSON body, when the city cannot be read', async () => {
    const res = await (await build(stubRepos({ fail: true }))).inject({ method: 'GET', url: '/city/@pedro' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(CITY_MARKER);
    expect(res.body).toContain('Cidade não encontrada');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // The paths buildApp reads by default must be where the web workspace actually builds to.
  it("reads the bundles from where the web workspace's builds write them", () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const d = defaultFrontendDirs(root);
    expect(d.webDist).toBe(path.join(root, 'apps', 'web', 'dist'));
    expect(d.cityDist).toBe(path.join(root, 'apps', 'web', 'dist-city'));
    const cityConfig = fs.readFileSync(path.join(root, 'apps', 'web', 'vite.city.config.ts'), 'utf8');
    expect(cityConfig).toContain("outDir: 'dist-city'");
    expect(cityConfig).toContain(`input: '${CITY_INDEX}'`);
    expect(cityConfig).toContain("base: '/city/'");
  });
});

// The same, booted through the real buildApp against a migrated database: the wiring as production runs it.
describe.skipIf(process.env.TERMHUB_DB_TESTS !== '1')('buildApp serving the frontends (Postgres)', () => {
  const dirs = fixtureDirs();
  let app: Awaited<ReturnType<typeof import('./app.js')['buildApp']>>;
  const cleanup: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    const { buildApp } = await import('./app.js');
    // No boot requeue: the pending attachments in this shared database belong to other test files.
    app = await buildApp({ frontend: { webDist: dirs.webDist, cityDist: dirs.cityDist }, requeueAttachments: false });
  }, 30_000);

  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => {});
    await app?.fastify.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  });

  it('serves /city/@nick from dist-city, its assets, and the app at /*', async () => {
    const { repos } = app;
    const { newId } = await import('./lib/ids.js');
    const { SYSTEM_ROLE_IDS } = await import('./db/repositories/roles.js');
    const nick = `fx${newId().slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    const user = await repos.users.create({ email: `${newId()}@x.dev`, name: 'Fixture Owner', role_id: SYSTEM_ROLE_IDS.authenticated });
    cleanup.push(() => repos.users.delete(user.id));
    expect(await repos.users.setNickname(user.id, nick)).toBe('ok');
    const machine = await repos.machines.create({ name: 'Fixture HQ', type: 'agent', owner_id: user.id });
    cleanup.push(() => repos.machines.delete(machine.id));
    const project = await repos.projects.create({ owner_id: user.id, key: `FX${newId().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, name: 'Fixture Room' });
    cleanup.push(() => repos.projects.delete(project.id));
    await repos.projectMachines.link({ project_id: project.id, machine_id: machine.id, cwd: '/tmp' });
    await repos.projects.update(project.id, { is_public: true });

    const city = await app.fastify.inject({ method: 'GET', url: `/city/@${nick}` });
    expect(city.statusCode).toBe(200);
    expect(city.body).toContain(CITY_MARKER);
    expect(city.body).not.toContain(APP_MARKER);
    expect(city.body).toContain('A cidade de Fixture Owner no termhub');

    expect((await app.fastify.inject({ method: 'GET', url: '/city/assets/city.js' })).body).toBe('console.log("city")');
    const spa = await app.fastify.inject({ method: 'GET', url: '/office' });
    expect(spa.body).toContain(APP_MARKER);
    // both documents carry the CSP (TER-579); JSON does not need it
    expect(city.headers['content-security-policy']).toContain("script-src 'self'");
    expect(spa.headers['content-security-policy']).toContain("script-src 'self'");
    const snapshot = await app.fastify.inject({ method: 'GET', url: `/api/public/city/${nick}` });
    expect(snapshot.headers['content-security-policy']).toBeUndefined();
    const { publicId } = await import('./public/public-id.js');
    // the building is the project, under its project's public id, and the machine is named nowhere
    expect(snapshot.json().buildings[0].id).toBe(publicId('project', project.id));
    expect(snapshot.json().buildings[0].name).toBe('Fixture Room');
    expect(snapshot.body).not.toContain('Fixture HQ');
  });
});
