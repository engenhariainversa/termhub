import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = new URL('../../dist-city/assets', import.meta.url).pathname;
const built = existsSync(dist);

/**
 * The point of the second bundle: what goes to the street must not contain the private app. This is
 * the only automated guard standing between the two, so it steps aside only where stepping aside
 * costs nothing — a local `npm test` on a checkout nobody has built yet. Under CI it never steps
 * aside: the workflow builds `dist-city` ahead of the web tests, and if that step is ever dropped
 * this fails loudly instead of skipping green, which is the same as having no guard at all.
 */
describe.skipIf(!built && !process.env.CI)('the public bundle', () => {
  it('does not carry the private app', () => {
    expect(built, 'dist-city is missing: run `npm run build:city -w @termhub/web` before the tests').toBe(true);
    const js = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
    // The first four are the app's routes as a person reads them. `lib/api.ts` builds its URLs as
    // `/api${path}` at runtime, so two of those never appear as literals even in the private bundle
    // — the three after them are what a leak would really drag in: the api client's own literals,
    // its CSRF cookie, and the monitor's channel.
    for (const marker of ['/api/machines', '/api/projects', '/ws/monitor', '/api/auth/me', '/api/auth/google', '/api/tabs/', 'termhub_csrf']) {
      expect(js).not.toContain(marker);
    }
  });
});

const SRC = new URL('..', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The same rule, read from the source: runs everywhere (no build needed), and names the file and the
 * import that broke it. The city may import the office, the public types, the i18n module (its catalogs
 * are copy, not app code), its own files and packages.
 */
describe('the public bundle source', () => {
  it('imports nothing of the private app', () => {
    const bad: string[] = [];
    for (const file of sources(join(SRC, 'city'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const target = relative(SRC, resolve(dirname(file), spec));
        if (target.startsWith('city/') || target.startsWith('office/') || target === 'i18n' || target.startsWith('i18n/') || target === 'lib/types' || target === 'lib/types.ts') continue;
        bad.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
