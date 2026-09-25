import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyErrorHandler, HttpError } from '../lib/errors.js';

const answer = vi.fn(async (..._a: unknown[]) => ({ id: 'q1', status: 'answered' }));
const screen = vi.fn(async (..._a: unknown[]) => ({ text: 'Do you want to proceed?' }));
const pin = vi.fn((..._a: unknown[]) => false);
vi.mock('../chat/tab-question-answer.js', () => ({
  answerTabQuestion: (...a: unknown[]) => answer(...a),
  tabQuestionScreen: (...a: unknown[]) => screen(...a),
  requirePinFor: (...a: unknown[]) => pin(...a),
}));

const { chatRoutes } = await import('./chat.js');
const { mobileChatRoutes } = await import('./m-chat.js');

function build(kind: 'web' | 'mobile') {
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  const repos = {};
  if (kind === 'web') app.register((a) => chatRoutes(a, repos as never, { service: {} as never }), { prefix: '/chat' });
  else app.register((a) => mobileChatRoutes(a, repos as never, { chat: {} as never, agents: {} as never, session: {} as never }), { prefix: '/chat' });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe.each(['web', 'mobile'] as const)('%s tab-question routes', (kind) => {
  it('POST answer hands the id, the raw body and the signed-in user\'s context to the service', async () => {
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_question: { id: 'q1', status: 'answered' } });
    const [ctx, id, body] = answer.mock.calls[0]!;
    expect((ctx as { scope: { user: { id: string } } }).scope.user.id).toBe('u1');
    expect(id).toBe('q1');
    expect(body).toEqual({ allow: true });
  });

  it('GET screen answers the excerpt', async () => {
    const res = await build(kind).inject({ method: 'GET', url: '/chat/tab-questions/q1/screen' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'Do you want to proceed?' });
    expect(screen.mock.calls[0]![1]).toBe('q1');
  });

  it('refuses an id that is not one', async () => {
    const res = await build(kind).inject({ method: 'POST', url: `/chat/tab-questions/${'x'.repeat(65)}/answer`, payload: { allow: true } });
    expect(res.statusCode).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it('passes the service\'s 409 through', async () => {
    answer.mockRejectedValueOnce(new HttpError(409, 'A pergunta mudou na aba', 'TAB_PROMPT_CHANGED'));
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'A pergunta mudou na aba', code: 'TAB_PROMPT_CHANGED' });
  });
});

it('the mobile route asks requirePinFor before sending, and refuses when it says so', async () => {
  await build('mobile').inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
  const deps = answer.mock.calls[0]![3] as { beforeSend: (row: unknown, a: unknown) => void };
  expect(() => deps.beforeSend({ kind: 'permission' }, { allow: true })).not.toThrow();
  pin.mockReturnValueOnce(true);
  expect(() => deps.beforeSend({ kind: 'permission' }, { allow: true })).toThrow(expect.objectContaining({ statusCode: 403, code: 'PIN_REQUIRED' }));
  expect(pin).toHaveBeenCalledWith('permission', { allow: true });
});

it('the web route has no PIN hook', async () => {
  await build('web').inject({ method: 'POST', url: '/chat/tab-questions/q1/answer', payload: { allow: true } });
  expect((answer.mock.calls[0]![3] as { beforeSend?: unknown }).beforeSend).toBeUndefined();
});
