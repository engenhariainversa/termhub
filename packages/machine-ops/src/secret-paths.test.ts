import { describe, expect, it } from 'vitest';
import { isSecretPath } from './secret-paths.js';

describe('isSecretPath', () => {
  it.each([
    '~/.ssh/id_ed25519.png',
    '/home/u/.ssh/known_hosts.txt',
    '/home/u/app/.env',
    '/home/u/app/.env.local',
    '/home/u/app/prod.env',
    '/home/u/.claude/.credentials.json',
    '/home/u/.claude_work/settings.json',
    '/home/u/.codex/auth.json',
    '/home/u/.config/gh/hosts.yml',
    '/home/u/.aws/config',
    '/Users/u/Library/Keychains/login.keychain-db',
    '/home/u/app/credentials.json',
    '/home/u/app/client_secret.json',
    '/home/u/app/service-account.json',
    '/home/u/certs/server.pem',
    '/home/u/certs/server.key',
    '/home/u/.termhub/config.json',
    '/home/u/notes/tokens.txt',
  ])('refuses %s', (p) => expect(isSecretPath(p)).toBe(true));

  it.each(['~/termhub-linkedin/post-1.png', '/home/u/app/docs/report.pdf', '/tmp/screenshot.png', '/home/u/app/keyboard.png', '/home/u/app/environment.md', '/home/u/app/README.md'])('accepts %s', (p) =>
    expect(isSecretPath(p)).toBe(false),
  );
});
