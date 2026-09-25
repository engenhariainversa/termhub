import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyErrorHandler, HttpError } from '../lib/errors.js';

const send = vi.fn(async (..._a: unknown[]) => ({ id: 's1', status: 'answered' }));
const dismiss = vi.fn(async (..._a: unknown[]) => ({ id: 's1', status: 'dismissed' }));
vi.mock('../chat/tab-suggestion-send.js', () => ({
  sendTabSuggestion: (...a: unknown[]) => send(...a),
  dismissTabSuggestion: (...a: unknown[]) => dismiss(...a),
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

describe.each(['web', 'mobile'] as const)('%s tab-suggestion routes', (kind) => {
  it("POST send hands the id, the raw body and the signed-in user's context to the service", async () => {
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/send', payload: { text: 'commit it' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_suggestion: { id: 's1', status: 'answered' } });
    const [ctx, id, body] = send.mock.calls[0]!;
    expect((ctx as { scope: { user: { id: string } } }).scope.user.id).toBe('u1');
    expect(id).toBe('s1');
    expect(body).toEqual({ text: 'commit it' });
  });

  it('POST dismiss answers the dismissed card', async () => {
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/dismiss', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tab_suggestion: { id: 's1', status: 'dismissed' } });
    expect(dismiss.mock.calls[0]![1]).toBe('s1');
  });

  it('refuses an id that is not one', async () => {
    const res = await build(kind).inject({ method: 'POST', url: `/chat/tab-suggestions/${'x'.repeat(65)}/send`, payload: { text: 'a' } });
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("passes the service's 409 through", async () => {
    send.mockRejectedValueOnce(new HttpError(409, 'A sugestão mudou na aba', 'TAB_PROMPT_CHANGED'));
    const res = await build(kind).inject({ method: 'POST', url: '/chat/tab-suggestions/s1/send', payload: { text: 'commit it' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'A sugestão mudou na aba', code: 'TAB_PROMPT_CHANGED' });
  });
});
