import { beforeEach, describe, expect, it } from 'vitest';
import type { ConciergeNotice, NewConciergeNotice } from '../../db/repositories/concierge-notices.js';
import type { Repositories } from '../../db/repositories/index.js';
import { createNoticeDispatcher, type NoticeDispatcherDeps, type OutgoingNotice } from './dispatcher.js';
import { DEFAULT_NOTICE_SETTINGS, NOTICE_LIMITS, type NoticeSettings } from './rules.js';

/** The repository's guarantees, in memory: `claimSent` hands a notice to one caller only (both colours share it). */
class FakeNotices {
  rows: ConciergeNotice[] = [];
  private n = 0;
  constructor(private clock: () => Date) {}
  async create(input: NewConciergeNotice, now = this.clock()) {
    const row: ConciergeNotice = { id: `n${++this.n}`, ...input, message_id: null, status: 'pending', reason: null, created_at: now.toISOString(), ready_at: null, sent_at: null };
    this.rows.push(row);
    return { ...row };
  }
  async countPending(conversationId: string) {
    return this.rows.filter((r) => r.conversation_id === conversationId && r.status === 'pending').length;
  }
  async markReady(conversationId: string, messageId: string, now = this.clock()) {
    const hit = this.rows.filter((r) => r.conversation_id === conversationId && r.status === 'pending' && r.message_id === null && Date.parse(r.created_at) <= now.getTime());
    for (const r of hit) Object.assign(r, { message_id: messageId, ready_at: now.toISOString() });
    return hit.length;
  }
  async listReady(now: Date, readyAfterMs: number, filter: { userId?: string } = {}) {
    return this.rows.filter((r) => r.status === 'pending' && (!filter.userId || r.user_id === filter.userId) && (r.ready_at !== null || Date.parse(r.created_at) < now.getTime() - readyAfterMs)).map((r) => ({ ...r }));
  }
  async sentSince(conversationId: string, since: Date) {
    const times = new Set(this.rows.filter((r) => r.conversation_id === conversationId && r.status === 'sent' && Date.parse(r.sent_at!) >= since.getTime()).map((r) => r.sent_at!));
    return [...times].map((t) => new Date(t));
  }
  async claimSent(ids: string[], now = this.clock()) {
    return ids.filter((id) => {
      const r = this.rows.find((x) => x.id === id)!;
      if (r.status !== 'pending') return false;
      Object.assign(r, { status: 'sent', sent_at: now.toISOString() });
      return true;
    });
  }
  async drop(ids: string[], reason: string) {
    for (const r of this.rows) if (ids.includes(r.id) && r.status === 'pending') Object.assign(r, { status: 'dropped', reason });
  }
  async noteHeld(ids: string[], reason: string) {
    for (const r of this.rows) if (ids.includes(r.id) && r.status === 'pending') r.reason = reason;
  }
  async dropStaleBefore() {
    return 0;
  }
  async purgeBefore() {
    return 0;
  }
}

// Keeps the fake honest about the interface it stands in for.
const _typecheck: Pick<Repositories['conciergeNotices'], keyof FakeNotices & keyof Repositories['conciergeNotices']> = new FakeNotices(() => new Date());
void _typecheck;

let clock: Date;
let store: FakeNotices;
let sent: OutgoingNotice[];
let rules: NoticeSettings;
const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

function dispatcher(over: Partial<NoticeDispatcherDeps> = {}) {
  const repos = {
    conciergeNotices: store,
    users: { conciergePush: async () => rules, timeZone: async () => 'America/Sao_Paulo' },
    chat: { latestAssistantMessageId: async () => 'm-latest' },
  } as unknown as NoticeDispatcherDeps['repos'];
  return createNoticeDispatcher({ repos, send: async (n) => void sent.push(n), log: { info: () => {}, warn: () => {} }, now: () => clock, ...over });
}
const notice = (level: 'needs_you' | 'done', headline: string, conversation_id = 'c1') => store.create({ user_id: 'u1', conversation_id, project_id: 'p1', level, headline, watch_id: level === 'done' ? 'w1' : null });
const answerDone = async (d: ReturnType<typeof dispatcher>, messageId: string, conversationId = 'c1') => {
  d.answerDone('u1', conversationId, messageId);
  await d.dispatch();
};

beforeEach(() => {
  clock = new Date('2026-10-21T15:00:00.000Z'); // 12:00 in São Paulo
  store = new FakeNotices(() => clock);
  sent = [];
  rules = { ...DEFAULT_NOTICE_SETTINGS };
});

describe('concierge notices dispatcher (TER-1101)', () => {
  it('waits for the answer to end, then pushes with a deep link to that message', async () => {
    const d = dispatcher();
    await notice('done', 'Build pronto');
    await d.dispatch();
    expect(sent).toEqual([]);
    await answerDone(d, 'm1');
    expect(sent).toEqual([{ userId: 'u1', conversationId: 'c1', projectId: 'p1', messageId: 'm1', level: 'done', headline: 'Build pronto', count: 1 }]);
    expect(store.rows[0].status).toBe('sent');
    await d.dispatch();
    expect(sent).toHaveLength(1);
  });

  it('an answer that never said it ended is sent after a while, pointing at the newest answer', async () => {
    const d = dispatcher();
    await notice('needs_you', 'Preciso da sua aprovação');
    advance(NOTICE_LIMITS.readyAfterMs + 1);
    await d.dispatch();
    expect(sent[0]).toMatchObject({ messageId: 'm-latest', level: 'needs_you' });
  });

  it('drops a level the person turned off', async () => {
    rules = { ...rules, done: false };
    const d = dispatcher();
    await notice('done', 'PR mesclado');
    await answerDone(d, 'm1');
    expect(sent).toEqual([]);
    expect(store.rows[0]).toMatchObject({ status: 'dropped', reason: 'level_off' });
  });

  it('holds everything during quiet hours and sends it as one push when they end', async () => {
    rules = { ...rules, quiet_start: '11:00', quiet_end: '13:00' };
    const d = dispatcher();
    await notice('done', 'Build pronto');
    await answerDone(d, 'm1');
    await notice('needs_you', 'O deploy falhou');
    await answerDone(d, 'm2');
    expect(sent).toEqual([]);
    expect(store.rows.map((r) => r.reason)).toEqual(['quiet', 'quiet']);
    advance(3600_000); // 13:00 local
    await d.dispatch();
    expect(sent).toEqual([{ userId: 'u1', conversationId: 'c1', projectId: 'p1', messageId: 'm2', level: 'needs_you', headline: 'O deploy falhou', count: 2 }]);
  });

  it('groups what comes within minutes of a push into one push at the window\'s end', async () => {
    const d = dispatcher();
    await notice('done', 'Build pronto');
    await answerDone(d, 'm1');
    advance(60_000);
    await notice('done', 'Testes passaram');
    await answerDone(d, 'm2');
    advance(60_000);
    await notice('done', 'PR aberto');
    await answerDone(d, 'm3');
    expect(sent).toHaveLength(1);
    advance(3 * 60_000);
    await d.dispatch();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ messageId: 'm3', headline: 'PR aberto', count: 2 });
  });

  it('caps the pushes of a conversation per hour; another conversation has its own', async () => {
    rules = { ...rules, group_minutes: 0 };
    const d = dispatcher();
    for (let i = 0; i < NOTICE_LIMITS.perHour + 1; i++) {
      await notice('needs_you', `pergunta ${i}`);
      await answerDone(d, `m${i}`);
      advance(60_000);
    }
    expect(sent).toHaveLength(NOTICE_LIMITS.perHour);
    expect(store.rows.at(-1)).toMatchObject({ status: 'pending', reason: 'capped' });
    await notice('needs_you', 'outra conversa', 'c2');
    await answerDone(d, 'x1', 'c2');
    expect(sent).toHaveLength(NOTICE_LIMITS.perHour + 1);
    advance(3600_000);
    await d.dispatch();
    expect(sent).toHaveLength(NOTICE_LIMITS.perHour + 2);
  });

  it('two colours never send the same notice twice', async () => {
    const a = dispatcher();
    const b = dispatcher();
    await notice('done', 'Build pronto');
    a.answerDone('u1', 'c1', 'm1');
    await Promise.all([a.dispatch(), b.dispatch()]);
    expect(sent).toHaveLength(1);
  });

  it('a draining colour sends nothing', async () => {
    const d = dispatcher({ active: () => false });
    await notice('done', 'Build pronto');
    await answerDone(d, 'm1');
    expect(sent).toEqual([]);
    expect(store.rows[0].status).toBe('pending');
  });
});
