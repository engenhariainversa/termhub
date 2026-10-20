import { describe, expect, it } from 'vitest';
import {
  accountDeletedMail,
  alphaInviteMail,
  deletionCancelledMail,
  deletionDateLabel,
  deletionLinkMail,
  deletionRequestedMail,
  deviceRequestMail,
  deviceRevokedMail,
  inviteMail,
  loginCodeMail,
} from './templates.js';

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
    expect(done.text).not.toContain('cópias de segurança');
    expect(accountDeletedMail('a@x.dev', { backupRetentionDays: 30 }).text).toContain('cópias de segurança do banco de dados que ainda têm esses dados são apagadas em até 30 dias');
  });
});

/** No Portuguese left in an English e-mail: the words every pt-BR template uses. */
const PT_WORDS = /\b(você|sua|seu|conta|código|aparelho|exclusão|e-mail\.|ignore este|Acessar|Entrar)\b/i;

describe('every template in English (TER-405)', () => {
  const appUrl = 'https://app.termhub.dev';

  it('login code', () => {
    const mail = loginCodeMail('a@b.c', '123456', 10, 'en');
    expect(mail.subject).toBe('123456 — your termhub sign-in code');
    expect(mail.text).toBe('Your termhub sign-in code is: 123456\n\nIt expires in 10 minutes. If you did not ask for this code, ignore this e-mail.');
    expect(mail.html).toContain('lang="en"');
    expect(mail.html).toContain('Your sign-in code is');
    expect(mail.html).not.toMatch(PT_WORDS);
    expect(loginCodeMail('a@b.c', '123456', 10).subject).toBe('123456 — seu código de acesso ao termhub');
  });

  it('device request', () => {
    const mail = deviceRequestMail('a@b.c', { deviceLabel: 'iPhone 15 (iOS 18.1)', code: 'K7F2QD', place: 'Lisbon, PT', ip: '1.2.3.4', appUrl }, 'en');
    expect(mail.subject).toBe('A device is asking for access to your account');
    expect(mail.text).toContain('Device: iPhone 15 (iOS 18.1)');
    expect(mail.text).toContain('Location: Lisbon, PT (IP 1.2.3.4)');
    expect(mail.text).toContain('Code: K7F-2QD');
    expect(mail.text).toContain(`View request: ${appUrl}/settings/devices`);
    expect(mail.html).toContain('>View request</a>');
    expect(mail.html).toContain('lang="en"');
    expect(mail.text).not.toMatch(PT_WORDS);
  });

  it('device revoked, with the date written in English', () => {
    const mail = deviceRevokedMail('a@b.c', { deviceLabel: 'Ana (iPhone 15)', at: new Date('2026-09-24T15:30:00.000Z') }, 'en');
    expect(mail.subject).toBe('A device was removed from your account after wrong PIN attempts');
    expect(mail.text).toContain('When: 9/24/26');
    expect(mail.text).toContain('Nothing else changed in your account');
    expect(mail.text).not.toMatch(PT_WORDS);
  });

  it('invite, with the role and the Cloudflare Access line', () => {
    const mail = inviteMail('a@b.c', { invitedBy: 'Pedro <x>', appUrl, roleLabel: 'Member', accessAllowlisted: true }, 'en');
    expect(mail.subject).toBe('Pedro <x> invited you to termhub');
    expect(mail.text).toContain('Pedro <x> invited you to termhub as Member.');
    expect(mail.text).toContain(`Open: ${appUrl}`);
    expect(mail.text).toContain('Cloudflare Access');
    expect(mail.html).toContain('<strong>Pedro &lt;x&gt;</strong> invited you to termhub as <strong>Member</strong>.');
    expect(mail.html).toContain('>Open termhub</a>');
    expect(mail.text).not.toMatch(PT_WORDS);
    const pt = inviteMail('a@b.c', { invitedBy: 'Pedro', appUrl, roleLabel: 'Membro', accessAllowlisted: false });
    expect(pt.text.startsWith('Pedro convidou você para o termhub como Membro.\n\nAcesse: https://app.termhub.dev')).toBe(true);
    expect(pt.html).toContain('<strong>Pedro</strong> convidou você para o termhub como <strong>Membro</strong>.');
  });

  it('alpha invite takes the app locale too (pt-BR or en)', () => {
    expect(alphaInviteMail('a@b.c', { ...opts, locale: 'en' }).subject).toBe("You're in the termhub alpha 🚀");
    const pt = alphaInviteMail('a@b.c', { ...opts, locale: 'pt-BR' });
    expect(pt.html).toContain('lang="pt-BR"');
    expect(pt.html).toContain('feito em Goiânia');
  });

  it('deletion requested, with the date in English', () => {
    const at = new Date('2026-11-01T02:00:00.000Z');
    expect(deletionDateLabel(at, 'en')).toBe('October 31, 2026');
    const mail = deletionRequestedMail('a@b.c', { scheduledAt: at, appUrl }, 'en');
    expect(mail.subject).toBe('We received the request to delete your account');
    expect(mail.text).toContain('deleted for good on October 31, 2026.');
    expect(mail.text).toContain('"Cancel deletion"');
    expect(mail.text).toContain('Sign in and cancel the deletion: https://app.termhub.dev');
    expect(mail.html).toContain('lang="en"');
    expect(mail.text).not.toMatch(PT_WORDS);
  });

  it('deletion cancelled, account deleted and deletion link', () => {
    const cancelled = deletionCancelledMail('a@b.c', { appUrl }, 'en');
    expect(cancelled.subject).toBe('Your account deletion was cancelled');
    expect(cancelled.text).toContain('Open termhub: https://app.termhub.dev');
    const done = accountDeletedMail('a@b.c', { backupRetentionDays: 30 }, 'en');
    expect(done.subject).toBe('Your termhub account was deleted');
    expect(done.text).toContain('This is the last e-mail you get from termhub.');
    expect(done.text).toContain('The database backups that still hold this data are deleted within 30 days.');
    const link = deletionLinkMail('a@b.c', { link: 'https://termhub.dev/excluir-conta/?token=abc', ttlMinutes: 30 }, 'en');
    expect(link.subject).toBe('Confirm the deletion of your termhub account');
    expect(link.text).toContain('within the next 30 minutes');
    expect(link.text).toContain('Confirm deletion: https://termhub.dev/excluir-conta/?token=abc');
    for (const m of [cancelled, done, link]) expect(m.text.replace(/https:\/\/\S+/g, '')).not.toMatch(PT_WORDS);
  });
});

/** Words only Portuguese has (Spanish shares "código", "cuenta"…); none may reach a Spanish e-mail. */
const PT_ONLY = /\b(você|sua|seu|aparelho|exclusão|ignore este e-mail|Acessar|feito em)\b/i;

describe('every template in Spanish (TER-406)', () => {
  const appUrl = 'https://app.termhub.dev';
  const at = new Date('2026-11-01T02:00:00.000Z');

  it('login code', () => {
    const mail = loginCodeMail('a@b.c', '123456', 10, 'es');
    expect(mail.subject).toBe('123456 — tu código de acceso a termhub');
    expect(mail.text).toContain('Tu código de acceso a termhub es: 123456');
    expect(mail.html).toContain('lang="es"');
  });

  it('the date reads in Spanish', () => {
    expect(deletionDateLabel(at, 'es')).toBe('31 de octubre de 2026');
  });

  it('alpha invite from a Spanish waitlist sign-up', () => {
    const mail = alphaInviteMail('a@b.c', { ...opts, locale: 'es' });
    expect(mail.subject).toBe('Estás en la alpha de termhub 🚀');
    expect(mail.html).toContain('lang="es"');
    expect(mail.text).toContain('hecho en Goiânia');
  });

  it('no Portuguese left in any template', () => {
    const mails = [
      loginCodeMail('a@b.c', '123456', 10, 'es'),
      deviceRequestMail('a@b.c', { deviceLabel: 'iPhone 15 (iOS 18.1)', code: 'K7F2QD', place: 'Madrid, ES', ip: '1.2.3.4', appUrl }, 'es'),
      deviceRevokedMail('a@b.c', { deviceLabel: 'Ana (iPhone 15)', at }, 'es'),
      inviteMail('a@b.c', { invitedBy: 'Pedro', appUrl, roleLabel: 'Miembro', accessAllowlisted: true }, 'es'),
      alphaInviteMail('a@b.c', { ...opts, locale: 'es' }),
      deletionRequestedMail('a@b.c', { scheduledAt: at, appUrl }, 'es'),
      deletionCancelledMail('a@b.c', { appUrl }, 'es'),
      accountDeletedMail('a@b.c', { backupRetentionDays: 30 }, 'es'),
      deletionLinkMail('a@b.c', { link: 'https://termhub.dev/excluir-conta/?token=abc', ttlMinutes: 30 }, 'es'),
    ];
    for (const m of mails) {
      expect(m.html).toContain('lang="es"');
      expect(m.subject).not.toMatch(PT_ONLY);
      expect(m.text.replace(/https:\/\/\S+/g, '')).not.toMatch(PT_ONLY);
    }
  });
});
