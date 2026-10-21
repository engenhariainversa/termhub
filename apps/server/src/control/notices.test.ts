import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_LIMITS } from '../chat/notices/rules.js';
import type { ControlContext } from './context.js';
import { notify } from './notices.js';

const findByIdForUser = vi.fn();
const findWatch = vi.fn();
const create = vi.fn();
const countPending = vi.fn();
const inChat = { id: 'tok', scopes: ['read'], gated: true, chat_conversation_id: 'c1' } as ControlContext['token'];
const ctxWith = (token: ControlContext['token'] = inChat) =>
  ({
    repos: { chat: { findByIdForUser }, chatWatches: { findById: findWatch }, conciergeNotices: { create, countPending } },
    scope: { user: { id: 'u1' } },
    token,
  }) as unknown as ControlContext;

beforeEach(() => {
  for (const f of [findByIdForUser, findWatch, create, countPending]) f.mockReset();
  findByIdForUser.mockResolvedValue({ id: 'c1', project_id: 'p1' });
  findWatch.mockResolvedValue({ id: 'w1', user_id: 'u1', project_id: 'p1', status: 'done' });
  countPending.mockResolvedValue(0);
  create.mockResolvedValue({ id: 'n1' });
});

describe('notify (TER-1101)', () => {
  it('only works in the chat', async () => {
    await expect(notify(ctxWith(null as never), { level: 'needs_you', headline: 'x' })).rejects.toMatchObject({ code: 'NOT_IN_CHAT' });
  });

  it('fyi stays in the chat: nothing is queued', async () => {
    expect(await notify(ctxWith(), { level: 'fyi', headline: 'Só avisando' })).toMatchObject({ status: 'chat_only' });
    expect(create).not.toHaveBeenCalled();
  });

  it('queues needs_you for this conversation, with the headline on one line and cut', async () => {
    const headline = `Preciso   da sua\naprovação ${'x'.repeat(200)}`;
    expect(await notify(ctxWith(), { level: 'needs_you', headline })).toMatchObject({ status: 'queued', level: 'needs_you' });
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({ user_id: 'u1', conversation_id: 'c1', project_id: 'p1', level: 'needs_you', watch_id: null });
    expect(input.headline).toMatch(/^Preciso da sua aprovação x/);
    expect(input.headline).toHaveLength(NOTICE_LIMITS.headlineMax);
  });

  it('done needs a watch or reminder of this conversation the person asked to follow', async () => {
    await expect(notify(ctxWith(), { level: 'done', headline: 'PR mesclado' })).rejects.toMatchObject({ code: 'NOTICE_NOT_FOLLOWED' });
    findWatch.mockResolvedValueOnce({ id: 'w2', user_id: 'u2', project_id: 'p1' });
    await expect(notify(ctxWith(), { level: 'done', headline: 'PR mesclado', watch_id: 'w2' })).rejects.toMatchObject({ code: 'NOTICE_NOT_FOLLOWED' });
    findWatch.mockResolvedValueOnce({ id: 'w3', user_id: 'u1', project_id: 'p9' });
    await expect(notify(ctxWith(), { level: 'done', headline: 'PR mesclado', watch_id: 'w3' })).rejects.toMatchObject({ code: 'NOTICE_NOT_FOLLOWED' });
    // A watch that already fired (closed) still counts: that is when "done" is said.
    expect(await notify(ctxWith(), { level: 'done', headline: 'PR mesclado', watch_id: 'w1' })).toMatchObject({ status: 'queued' });
    expect(create.mock.calls[0][0]).toMatchObject({ level: 'done', watch_id: 'w1' });
  });

  it('refuses past the pending cap of the conversation', async () => {
    countPending.mockResolvedValue(NOTICE_LIMITS.pendingPerConversation);
    await expect(notify(ctxWith(), { level: 'needs_you', headline: 'x' })).rejects.toMatchObject({ code: 'NOTICE_LIMIT' });
  });
});
