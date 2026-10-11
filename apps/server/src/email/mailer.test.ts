import { describe, expect, it, vi } from 'vitest';
import { createMailer, maskEmail, type MailerLog } from './mailer.js';
import { loginCodeMail } from './templates.js';

const CODE = '482913';

function capture(): MailerLog & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: vi.fn((m: string) => void lines.push(m)), error: vi.fn((m: string) => void lines.push(m)) };
}

describe('createMailer without SMTP', () => {
  it('in production, never logs the login code, the subject or the full address, and fails the send', async () => {
    const log = capture();
    const mailer = createMailer(log, { smtp: null, isProd: true, devConsole: false });
    await expect(mailer.send(loginCodeMail('ana.souza@gmail.com', CODE, 10))).rejects.toThrow(/SMTP/);

    const all = log.lines.join('\n');
    expect(all).not.toContain(CODE);
    expect(all).not.toContain('ana.souza@gmail.com');
    expect(all).toContain('a***@gmail.com');
    expect(all).toMatch(/SMTP_HOST/);
    // The missing configuration is reported as an error at boot, before any send.
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/SMTP_HOST não configurado/));
  });

  it('in production, ignores the dev console flag', async () => {
    const log = capture();
    const mailer = createMailer(log, { smtp: null, isProd: true, devConsole: true });
    await expect(mailer.send(loginCodeMail('ana@gmail.com', CODE, 10))).rejects.toThrow();
    expect(log.lines.join('\n')).not.toContain(CODE);
  });

  it('in development without the explicit flag, also fails without printing the e-mail', async () => {
    const log = capture();
    const mailer = createMailer(log, { smtp: null, isProd: false, devConsole: false });
    await expect(mailer.send(loginCodeMail('ana@gmail.com', CODE, 10))).rejects.toThrow();
    const all = log.lines.join('\n');
    expect(all).not.toContain(CODE);
    expect(all).toMatch(/EMAIL_DEV_CONSOLE=true/);
  });

  it('in development with EMAIL_DEV_CONSOLE, prints the whole e-mail (the code included)', async () => {
    const log = capture();
    const mailer = createMailer(log, { smtp: null, isProd: false, devConsole: true });
    await mailer.send(loginCodeMail('ana@gmail.com', CODE, 10));
    const all = log.lines.join('\n');
    expect(all).toContain('ana@gmail.com');
    expect(all).toContain(CODE);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('pedro@example.com')).toBe('p***@example.com');
    expect(maskEmail('x@y.z')).toBe('x***@y.z');
  });

  it('never returns a malformed address unmasked', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
  });
});
