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

const prod = { NODE_ENV: 'production', AUTH_MODE: 'cloudflare', CF_TEAM_DOMAIN: 'https://x.cloudflareaccess.com', CF_AUD: 'aud' };

describe('config: database password in production', () => {
  it('refuses the compose fallback password', async () => {
    await expect(loadConfig({ ...prod, DATABASE_URL: 'postgresql://termhub:termhub@db:5432/termhub' })).rejects.toThrow(/senha padrão/);
  });

  it('accepts any other password, and no password at all (peer auth, .pgpass)', async () => {
    await expect(loadConfig({ ...prod, DATABASE_URL: 'postgresql://termhub:s3cr%2Ft@db:5432/termhub' })).resolves.toBeTruthy();
    await expect(loadConfig({ ...prod, DATABASE_URL: 'postgresql://termhub@db:5432/termhub' })).resolves.toBeTruthy();
  });

  it('leaves development alone', async () => {
    await expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://termhub:termhub@localhost:5434/termhub' })).resolves.toBeTruthy();
  });
});

describe('config: whisper secret', () => {
  it('turns transcription on only with both the URL and the secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await loadConfig({ WHISPER_URL: 'http://whisper:8000/', WHISPER_SECRET: '' })).transcription).toBeNull();
    expect((await loadConfig({ WHISPER_URL: 'http://whisper:8000/', WHISPER_SECRET: 's' })).transcription).toEqual({ url: 'http://whisper:8000', language: 'pt', secret: 's' });
  });
});

describe('config: SMTP proxy', () => {
  it('passes SMTP_PROXY to the SMTP settings', async () => {
    const config = await loadConfig({ SMTP_HOST: 'smtp.example.com', SMTP_PROXY: 'http://proxy:3128' });
    expect(config.email.smtp?.proxy).toBe('http://proxy:3128');
  });
});
