import { describe, expect, it } from 'vitest';
import { accountDeletedMail, alphaInviteMail, deletionCancelledMail, deletionDateLabel, deletionLinkMail, deletionRequestedMail, deviceRequestMail, deviceRevokedMail } from './templates.js';

const opts = { appUrl: 'https://app.termhub.dev', communityUrl: 'https://77a.it/comunidadetermhub', firstName: 'Ana' };

describe('alphaInviteMail', () => {
  it('writes the Portuguese variant with the app and community links', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt' });
    expect(mail.to).toBe('ana@gmail.com');
    expect(mail.subject).toContain('alpha');
    expect(mail.text).toContain('Ana');
    expect(mail.text).toContain(opts.appUrl);
    expect(mail.text).toContain(opts.communityUrl);
    expect(mail.text).toContain('WhatsApp');
    expect(mail.html).toContain(`href="${opts.communityUrl}"`);
  });

  it('writes the English variant for locale en', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'en' });
    expect(mail.subject).toMatch(/alpha/i);
    expect(mail.text).toContain('WhatsApp');
    expect(mail.text).toContain(opts.communityUrl);
    expect(mail.text).not.toMatch(/você|grupo/i);
    expect(mail.html).toContain('lang="en"');
  });

  it('carries the site footer (license, GitHub, docs, coffee, made in Goiânia)', () => {
    const pt = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt' });
    expect(pt.html).toContain('termhub · MIT');
    expect(pt.html).toContain('href="https://github.com/engenhariainversa/termhub"');
    expect(pt.html).toContain('href="https://github.com/engenhariainversa/termhub/blob/main/README.md"');
    expect(pt.html).toContain('href="https://buymeacoffee.com/pedrogoiania"');
    expect(pt.html).toContain('feito em Goiânia');
    const en = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'en' });
    expect(en.html).toContain('made in Goiânia');
  });

  it('escapes the first name in the html', () => {
    const mail = alphaInviteMail('ana@gmail.com', { ...opts, locale: 'pt', firstName: '<b>Ana</b>' });
    expect(mail.html).not.toContain('<b>Ana</b>');
    expect(mail.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
});

describe('deviceRequestMail', () => {
  it('carries the formatted code, the place, the link and escapes the device label', () => {
    const appUrl = 'https://app.termhub.dev';
    const mail = deviceRequestMail('a@b.c', { deviceLabel: 'iPhone 15 (iOS 18.1)', code: 'K7F2QD', place: 'São Paulo, BR', ip: '1.2.3.4', appUrl });
    expect(mail.to).toBe('a@b.c');
    expect(mail.subject).toBe('Um aparelho pede acesso à sua conta');
    expect(mail.text).toContain('K7F-2QD');
    expect(mail.html).toContain('K7F-2QD');
    expect(mail.text).toContain('São Paulo, BR');
    expect(mail.text).toContain('1.2.3.4');
    expect(mail.text).toContain('iPhone 15 (iOS 18.1)');
    expect(mail.text).toContain(`${appUrl}/settings/devices`);
    expect(mail.html).toContain(`href="${appUrl}/settings/devices"`);
    const evil = deviceRequestMail('a@b.c', { deviceLabel: '<script>x</script>', code: 'K7F2QD', place: 'X', ip: '1.2.3.4', appUrl });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });
});

describe('deviceRevokedMail', () => {
  it('names the device and the time, says nothing else changed, and escapes the label', () => {
    const at = new Date('2026-09-24T15:30:00.000Z');
    const mail = deviceRevokedMail('a@b.c', { deviceLabel: 'iPhone de Ana (iPhone 15)', at });
    expect(mail.to).toBe('a@b.c');
    expect(mail.subject).toBe('Um aparelho foi removido da sua conta por tentativas de PIN');
    expect(mail.text).toContain('iPhone de Ana (iPhone 15)');
    expect(mail.text).toContain('24/09/2026');
    expect(mail.text).toContain('Nada mais foi alterado');
    const evil = deviceRevokedMail('a@b.c', { deviceLabel: '<script>x</script>' });
    expect(evil.html).not.toContain('<script>');
    expect(evil.html).toContain('&lt;script&gt;');
  });
});

describe('account deletion e-mails (TER-720, TER-728)', () => {
  it('the request e-mail gives the final date in Brasília time and the way to cancel', () => {
    // 02:00 UTC on Nov 1 is still Oct 31 in Brasília.
    const mail = deletionRequestedMail('ana@gmail.com', { scheduledAt: new Date('2026-11-01T02:00:00.000Z'), appUrl: 'https://app.termhub.dev' });
    expect(deletionDateLabel(new Date('2026-11-01T02:00:00.000Z'))).toBe('31 de outubro de 2026');
    expect(mail.text).toContain('31 de outubro de 2026');
    expect(mail.text).toContain('Cancelar exclusão');
    expect(mail.text).toContain('6 meses');
    expect(mail.html).toContain('href="https://app.termhub.dev"');
  });

  it('the link e-mail carries the link, its lifetime and the "ignore it" line', () => {
    const mail = deletionLinkMail('ana@gmail.com', { link: 'https://termhub.dev/excluir-conta/?token=abc&x=<y>', ttlMinutes: 30 });
    expect(mail.text).toContain('https://termhub.dev/excluir-conta/?token=abc');
    expect(mail.text).toContain('30 minutos');
    expect(mail.text).toContain('ignore este e-mail');
    expect(mail.html).not.toContain('<y>');
  });

  it('cancel and final notices', () => {
    expect(deletionCancelledMail('a@x.dev', { appUrl: 'https://app.termhub.dev' }).subject).toBe('A exclusão da sua conta foi cancelada');
    const done = accountDeletedMail('a@x.dev');
    expect(done.subject).toBe('Sua conta do termhub foi excluída');
    expect(done.html).not.toContain('href=');
  });
});
