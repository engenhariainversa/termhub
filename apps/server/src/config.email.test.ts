import { afterEach, describe, expect, it, vi } from 'vitest';

/** config.ts validates the environment at import time, so each case re-imports it. */
async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('./config.js')).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('config: EMAIL_DEV_CONSOLE', () => {
  it('refuses to boot in production with the dev console on', async () => {
    await expect(loadConfig({ NODE_ENV: 'production', EMAIL_DEV_CONSOLE: 'true', SMTP_HOST: '' })).rejects.toThrow(/EMAIL_DEV_CONSOLE/);
  });

  it('is off unless set, and on in development when set', async () => {
    expect((await loadConfig({ NODE_ENV: 'development' })).email.devConsole).toBe(false);
    expect((await loadConfig({ NODE_ENV: 'development', EMAIL_DEV_CONSOLE: 'true' })).email.devConsole).toBe(true);
  });

  it('reports a missing SMTP_HOST in production as an error at boot', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'app', SMTP_HOST: '' });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/SMTP_HOST não configurado/));
  });
});
