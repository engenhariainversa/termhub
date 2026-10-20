import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { LegalVersion } from '../db/repositories/legal-status.js';
import type { Mail } from '../email/mailer.js';
import { legalChangeNoticeMail } from '../email/templates.js';
import { sendDueLegalNotices } from './notices.js';

const terms: LegalVersion = {
  id: 't2',
  document: 'terms',
  version: '2',
  effective_at: '2026-11-10T15:00:00.000Z',
  url: 'https://termhub.dev/termos/',
  requires_acceptance: true,
  summary: 'Novo prazo de guarda dos registros',
};
const privacy: LegalVersion = { ...terms, id: 'p2', document: 'privacy', url: 'https://termhub.dev/privacidade/', summary: null };

function deps(claimed: LegalVersion[], opts: { failFor?: string; active?: boolean } = {}) {
  const sent: Mail[] = [];
  const users = [
    { id: 'u1', email: 'ana@x.dev', locale: null, deletion_scheduled_at: null },
    { id: 'u2', email: 'bob@x.dev', locale: 'en', deletion_scheduled_at: null },
    { id: 'u3', email: 'gone@x.dev', locale: null, deletion_scheduled_at: '2026-11-01T00:00:00.000Z' },
  ];
  const repos = {
    legal: { claimDueNotices: vi.fn(async () => claimed) },
    users: { list: vi.fn(async () => users) },
  } as unknown as Pick<Repositories, 'legal' | 'users'>;
  const mailer = {
    send: vi.fn(async (m: Mail) => {
      if (m.to === opts.failFor) throw new Error('smtp down');
      sent.push(m);
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn() };
  return { repos, mailer, log, sent, active: opts.active === undefined ? undefined : () => opts.active! };
}

describe('sendDueLegalNotices', () => {
  it('does nothing when no version is due', async () => {
    const d = deps([]);
    expect(await sendDueLegalNotices(d)).toBe(0);
    expect(d.repos.users.list).not.toHaveBeenCalled();
    expect(d.mailer.send).not.toHaveBeenCalled();
  });

  it('e-mails every account not pending deletion once, in its language', async () => {
    const d = deps([terms, privacy]);
    expect(await sendDueLegalNotices(d)).toBe(2);
    expect(d.sent.map((m) => m.to)).toEqual(['ana@x.dev', 'bob@x.dev']);
    expect(d.sent[0]!.subject).toBe('Mudanças nos Termos de Uso e na Política de Privacidade');
    expect(d.sent[1]!.subject).toBe('Changes to the Terms of Use and the Privacy Policy');
    // the log carries counts and ids, never addresses
    expect(JSON.stringify(d.log.info.mock.calls)).not.toContain('@');
  });

  it('one failed e-mail does not stop the others', async () => {
    const d = deps([terms], { failFor: 'ana@x.dev' });
    expect(await sendDueLegalNotices(d)).toBe(1);
    expect(d.sent.map((m) => m.to)).toEqual(['bob@x.dev']);
    expect(d.log.warn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'legal notice: e-mail failed');
  });

  it('a draining colour claims nothing', async () => {
    const d = deps([terms], { active: false });
    expect(await sendDueLegalNotices(d)).toBe(0);
    expect(d.repos.legal.claimDueNotices).not.toHaveBeenCalled();
  });
});

describe('legalChangeNoticeMail', () => {
  it('one document: its date, summary and a button to the new version', () => {
    const m = legalChangeNoticeMail('ana@x.dev', [terms]);
    expect(m.subject).toBe('Mudanças nos Termos de Uso');
    expect(m.text).toContain('Os Termos de Uso do termhub mudam em 10 de novembro de 2026.');
    expect(m.text).toContain('O que muda: Novo prazo de guarda dos registros');
    expect(m.text).toContain('Ler a nova versão: https://termhub.dev/termos/');
    expect(m.html).toContain('href="https://termhub.dev/termos/"');
  });

  it('both documents, in English: each link in the text', () => {
    const m = legalChangeNoticeMail('bob@x.dev', [terms, privacy], 'en');
    expect(m.text).toContain("termhub's Terms of Use change on November 10, 2026.");
    expect(m.text).toContain("termhub's Privacy Policy changes on November 10, 2026.");
    expect(m.text).toContain('Read the new version: https://termhub.dev/privacidade/');
  });

  it('privacy only', () => {
    expect(legalChangeNoticeMail('x@x.dev', [privacy]).subject).toBe('Mudanças na Política de Privacidade');
  });
});
