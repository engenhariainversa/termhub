import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionStatusResponse, lessonForgetSchema, lessonItemSchema, lessonListSchema, memoryReplacementsResponse, noteStatusResponse } from '@termhub/mobile-api';
import { config } from '../config.js';
import { applyErrorHandler } from '../lib/errors.js';

vi.mock('../chat/tab-questions.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../chat/tab-questions.js')>()), publishTabQuestions: vi.fn(async () => []) }));
vi.mock('../memory/note.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../memory/note.js')>()), indexProjectNote: vi.fn(async () => ({ sections: 0, lessons: 0 })) }));
const { publishTabQuestions } = await import('../chat/tab-questions.js');
const { indexProjectNote } = await import('../memory/note.js');
const { chatRoutes } = await import('./chat.js');
const { mobileChatRoutes } = await import('./m-chat.js');

function fakeRepos() {
  return {
    chatDecisions: {
      listForUser: vi.fn(async () => ({ items: [], next_cursor: null })),
      deleteForUser: vi.fn(async () => true),
      countForUser: vi.fn(async () => 0),
      findManyForUser: vi.fn(async () => [] as unknown[]),
    },
    memoryStatus: {
      setStatus: vi.fn(async () => 'ok' as string),
      supersedersOf: vi.fn(async () => new Map<string, { ref: string; title: string }>()),
    },
    memoryItems: {
      listNotes: vi.fn(async () => ({ items: [], next_cursor: null })),
      deleteNote: vi.fn(async () => true),
      countNotesSince: vi.fn(async () => 0),
      listLessons: vi.fn(async () => ({ items: [], next_cursor: null })),
      findLessonForOwner: vi.fn(async () => null as unknown),
      setVerified: vi.fn(async () => true),
      clearVerified: vi.fn(async () => true),
      hideSource: vi.fn(async () => true),
      deleteBySource: vi.fn(async () => 0),
      findManyForOwner: vi.fn(async () => [] as unknown[]),
    },
    notes: {
      removeBlock: vi.fn(async () => ({ id: 'n1', project_id: 'p1', content: '', updated_at: '2026-09-27T00:00:00.000Z' }) as unknown),
    },
    projects: {
      findById: vi.fn(async (id: string) => (id === 'p1' ? { id: 'p1', owner_id: 'u1', name: 'Proj', key: 'PJ' } : null) as unknown),
    },
    users: {
      chatSuggestions: vi.fn(async () => true),
      setChatSuggestions: vi.fn(async () => undefined),
      chatAutodecide: vi.fn(async () => false),
      setChatAutodecide: vi.fn(async () => undefined),
      chatCodexReplies: vi.fn(async () => false),
      setChatCodexReplies: vi.fn(async () => undefined),
    },
    tabQuestions: {
      cancelScheduledForUser: vi.fn(async (_userId: string) => [] as { id: string }[]),
    },
  };
}

/** A `lesson` memory item (chunk 0), as `findLessonForOwner`/`listLessons` return it. */
function lessonItem(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'l1',
    owner_id: 'u1',
    project_id: 'p1',
    project_name: 'Proj',
    kind: 'lesson',
    source_id: 'p1machine:docs/lessons/2026-09-27-x.md',
    chunk_index: 0,
    title: 'P3009: migrate found failed migrations',
    text: 'Causa: ...\nCorreção: ...',
    trust: 'derived',
    content_hash: 'h1',
    source_hash: 'sh1',
    embed_model: null,
    meta: { evidence: 'fixed', card: 'TER-57', pr: 'https://github.com/x/y/pull/169', tags: [], agent: 'claude', tab_id: null, origin: 'file', path: 'docs/lessons/2026-09-27-x.md' },
    verified: false,
    verified_at: null,
    source_at: '2026-09-27T00:00:00.000Z',
    created_at: '2026-09-27T00:00:00.000Z',
    updated_at: '2026-09-27T00:00:00.000Z',
    ...overrides,
  };
}

function build(kind: 'web' | 'mobile', repos: ReturnType<typeof fakeRepos>) {
  const app = Fastify();
  applyErrorHandler(app);
  app.decorateRequest('scope', null);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { scope: unknown }).scope = { user: { id: 'u1' }, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
  });
  if (kind === 'web') app.register((a) => chatRoutes(a, repos as never, { service: {} as never }), { prefix: '/chat' });
  else app.register((a) => mobileChatRoutes(a, repos as never, { chat: {} as never, agents: {} as never, session: {} as never }), { prefix: '/chat' });
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe.each(['web', 'mobile'] as const)('%s chat memory routes', (kind) => {
  it('GET /decisions passes the user, q, cursor and the fixed page size, and never leaks embedding', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.listForUser.mockResolvedValueOnce({
      items: [
        {
          id: 'd1',
          user_id: 'u1',
          project_id: 'p1',
          project_name: 'Proj',
          conversation_id: 'c1',
          tab_question_id: 'q1',
          question_index: 0,
          header: 'Header',
          question: 'Question?',
          options: [{ label: 'a', description: 'da' }],
          multi_select: false,
          answer: { labels: ['a'] },
          embed_model: 'm',
          suggested_count: 2,
          accepted_count: 1,
          status: 'current',
          expires_at: null,
          supersedes: null,
          created_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/decisions?q=abc&cursor=xyz' });
    expect(res.statusCode).toBe(200);
    expect(repos.chatDecisions.listForUser).toHaveBeenCalledWith('u1', { q: 'abc', cursor: 'xyz', limit: 50 });
    const body = res.json();
    expect(body.next_cursor).toBe('CURSOR');
    expect(body.decisions).toHaveLength(1);
    const decision = body.decisions[0];
    expect(decision).toEqual({
      id: 'd1',
      project_id: 'p1',
      project_name: 'Proj',
      header: 'Header',
      question: 'Question?',
      options: [{ label: 'a', description: 'da' }],
      multi_select: false,
      answer: { labels: ['a'] },
      suggested_count: 2,
      accepted_count: 1,
      created_at: '2026-09-26T00:00:00.000Z',
      status: 'current',
      expires_at: null,
      superseded_by: null,
    });
    expect(decision).not.toHaveProperty('embedding');
    expect(decision).not.toHaveProperty('user_id');
    expect(decision).not.toHaveProperty('conversation_id');
    expect(decision).not.toHaveProperty('tab_question_id');
    expect(decision).not.toHaveProperty('question_index');
    expect(decision).not.toHaveProperty('embed_model');
  });

  it('GET /decisions refuses a q over 200 chars', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'GET', url: `/chat/decisions?q=${'a'.repeat(201)}` });
    expect(res.statusCode).toBe(400);
    expect(repos.chatDecisions.listForUser).not.toHaveBeenCalled();
  });

  it('DELETE /decisions/:id calls deleteForUser and answers 204 whether or not it existed', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.deleteForUser.mockResolvedValueOnce(true);
    const res1 = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/decisions/d1' });
    expect(res1.statusCode).toBe(204);
    expect(repos.chatDecisions.deleteForUser).toHaveBeenCalledWith('d1', 'u1');

    const repos2 = fakeRepos();
    repos2.chatDecisions.deleteForUser.mockResolvedValueOnce(false);
    const res2 = await build(kind, repos2).inject({ method: 'DELETE', url: '/chat/decisions/missing' });
    expect(res2.statusCode).toBe(204);
  });

  it('GET /memory answers the suggestion switch, autodecide, availability, decisions count and notes count (no EMBED_URL in tests)', async () => {
    const repos = fakeRepos();
    repos.users.chatSuggestions.mockResolvedValueOnce(true);
    repos.users.chatAutodecide.mockResolvedValueOnce(true);
    repos.chatDecisions.countForUser.mockResolvedValueOnce(7);
    repos.memoryItems.countNotesSince.mockResolvedValueOnce(2);
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/memory' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, autodecide: true, codex_replies: false, available: false, count: 7, notes: 2 });
    expect(repos.memoryItems.countNotesSince).toHaveBeenCalledWith('u1', new Date(0));
  });

  it('PATCH /memory sets the suggestion switch and leaves autodecide alone', async () => {
    const repos = fakeRepos();
    repos.users.chatSuggestions.mockResolvedValueOnce(false);
    repos.chatDecisions.countForUser.mockResolvedValueOnce(3);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatSuggestions).toHaveBeenCalledWith('u1', false);
    expect(repos.users.setChatAutodecide).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ enabled: false, autodecide: false, codex_replies: false, available: false, count: 3, notes: 0 });
  });

  it('PATCH /memory sets autodecide and leaves the suggestion switch alone', async () => {
    const repos = fakeRepos();
    repos.users.chatAutodecide.mockResolvedValueOnce(true);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: true } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatAutodecide).toHaveBeenCalledWith('u1', true);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ autodecide: true });
  });

  it('PATCH /memory sets the Codex reply switch and leaves the others alone', async () => {
    const repos = fakeRepos();
    repos.users.chatCodexReplies.mockResolvedValueOnce(true);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { codex_replies: true } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatCodexReplies).toHaveBeenCalledWith('u1', true);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
    expect(repos.users.setChatAutodecide).not.toHaveBeenCalled();
    expect(res.json()).toMatchObject({ codex_replies: true });
  });

  it('PATCH /memory with autodecide: false cancels the user\'s running countdowns and republishes those cards', async () => {
    const repos = fakeRepos();
    const cancelled = [{ id: 'q1', user_id: 'u1' }, { id: 'q2', user_id: 'u1' }];
    repos.tabQuestions.cancelScheduledForUser.mockResolvedValueOnce(cancelled);
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: false } });
    expect(res.statusCode).toBe(200);
    expect(repos.users.setChatAutodecide).toHaveBeenCalledWith('u1', false);
    expect(repos.tabQuestions.cancelScheduledForUser).toHaveBeenCalledWith('u1');
    // The switch is stored first, so the repeat path cannot schedule a new one behind the cancel.
    expect(repos.users.setChatAutodecide.mock.invocationCallOrder[0]!).toBeLessThan(repos.tabQuestions.cancelScheduledForUser.mock.invocationCallOrder[0]!);
    expect(publishTabQuestions).toHaveBeenCalledWith(repos, 'tab_question', cancelled, { update: true });
  });

  it('PATCH /memory with autodecide: true (or only enabled) cancels nothing', async () => {
    const repos = fakeRepos();
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: true } });
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: false } });
    expect(repos.tabQuestions.cancelScheduledForUser).not.toHaveBeenCalled();
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });

  it('PATCH /memory with autodecide: false and nothing counting down publishes nothing', async () => {
    const repos = fakeRepos();
    await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { autodecide: false } });
    expect(repos.tabQuestions.cancelScheduledForUser).toHaveBeenCalledWith('u1');
    expect(publishTabQuestions).not.toHaveBeenCalled();
  });

  it('PATCH /memory refuses an empty body (neither key)', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
    expect(repos.users.setChatAutodecide).not.toHaveBeenCalled();
  });

  it('GET and PATCH /memory answer available: true when embeddings are configured', async () => {
    const saved = config.embeddings;
    config.embeddings = { url: 'http://embed:8000', secret: 's' };
    try {
      const repos = fakeRepos();
      const app = build(kind, repos);
      const got = await app.inject({ method: 'GET', url: '/chat/memory' });
      expect(got.json()).toMatchObject({ available: true });
      const patched = await app.inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: true } });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ available: true });
    } finally {
      config.embeddings = saved;
    }
  });

  it('PATCH /memory refuses a non-boolean enabled', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'PATCH', url: '/chat/memory', payload: { enabled: 'no' } });
    expect(res.statusCode).toBe(400);
    expect(repos.users.setChatSuggestions).not.toHaveBeenCalled();
  });

  it('GET /notes passes the user and cursor, maps question/decision/reason from the stored text', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listNotes.mockResolvedValueOnce({
      items: [
        {
          id: 'n1',
          owner_id: 'u1',
          project_id: 'p1',
          project_name: 'Proj',
          kind: 'note',
          source_id: 'n1',
          chunk_index: 0,
          title: 'Qual gerenciador de pacotes devo usar?',
          text: 'Decisão: npm\nMotivo: é o padrão do Node\nFontes: spec.md',
          trust: 'derived',
          content_hash: 'h',
          source_hash: null,
          embed_model: null,
          status: 'superseded',
          expires_at: null,
          supersedes: null,
          source_at: '2026-09-26T00:00:00.000Z',
          created_at: '2026-09-26T00:00:00.000Z',
          updated_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
    repos.memoryStatus.supersedersOf.mockResolvedValueOnce(new Map([['note:n1', { ref: 'decision:d9', title: 'Qual gerenciador?' }]]));
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/notes?cursor=xyz' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.listNotes).toHaveBeenCalledWith('u1', { cursor: 'xyz', limit: 50 });
    expect(repos.memoryStatus.supersedersOf).toHaveBeenCalledWith('u1', ['note:n1']);
    expect(res.json()).toEqual({
      notes: [
        {
          id: 'n1',
          project_id: 'p1',
          project_name: 'Proj',
          question: 'Qual gerenciador de pacotes devo usar?',
          decision: 'npm',
          reason: 'é o padrão do Node',
          created_at: '2026-09-26T00:00:00.000Z',
          status: 'superseded',
          expires_at: null,
          superseded_by: { ref: 'decision:d9', title: 'Qual gerenciador?' },
        },
      ],
      next_cursor: 'CURSOR',
    });
  });

  it('GET /notes answers empty decision/reason for a note missing those lines, never throwing', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listNotes.mockResolvedValueOnce({
      items: [
        {
          id: 'n1',
          owner_id: 'u1',
          project_id: null,
          project_name: null,
          kind: 'note',
          source_id: 'n1',
          chunk_index: 0,
          title: 'Q',
          text: 'nada aqui',
          trust: 'derived',
          content_hash: 'h',
          source_hash: null,
          embed_model: null,
          status: 'current',
          expires_at: null,
          supersedes: null,
          source_at: '2026-09-26T00:00:00.000Z',
          created_at: '2026-09-26T00:00:00.000Z',
          updated_at: '2026-09-26T00:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/notes' });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes[0]).toEqual({
      id: 'n1',
      project_id: null,
      project_name: null,
      question: 'Q',
      decision: '',
      reason: '',
      created_at: '2026-09-26T00:00:00.000Z',
      status: 'current',
      expires_at: null,
      superseded_by: null,
    });
  });

  const decisionRow = (over: Record<string, unknown> = {}) => ({
    id: 'd1', user_id: 'u1', project_id: 'p1', project_name: 'Proj', conversation_id: null, tab_question_id: null, question_index: 0,
    header: 'H', question: 'Q?', options: [{ label: 'a', description: '' }], multi_select: false, answer: { labels: ['a'] },
    embed_model: null, suggested_count: 0, accepted_count: 0, auto_count: 0, status: 'current', expires_at: null, supersedes: null,
    created_at: '2026-09-26T00:00:00.000Z', ...over,
  });

  it('PUT /decisions/:id/status marks the requester\'s decision and answers it as the list shows it (TER-1013)', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.findManyForUser.mockResolvedValueOnce([decisionRow({ status: 'wrong' })]);
    const res = await build(kind, repos).inject({ method: 'PUT', url: '/chat/decisions/d1/status', payload: { status: 'wrong' } });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryStatus.setStatus).toHaveBeenCalledWith('u1', { kind: 'decision', id: 'd1' }, 'wrong', undefined);
    expect(repos.chatDecisions.findManyForUser).toHaveBeenCalledWith(['d1'], 'u1');
    expect(decisionStatusResponse.parse(res.json()).decision).toMatchObject({ id: 'd1', status: 'wrong', superseded_by: null });
  });

  it('PUT /notes/:id/status superseded passes the replacement and shows it', async () => {
    const repos = fakeRepos();
    repos.memoryStatus.supersedersOf.mockResolvedValueOnce(new Map([['note:n1', { ref: 'decision:d2', title: 'Nova?' }]]));
    repos.memoryItems.findManyForOwner.mockResolvedValueOnce([
      { id: 'n1', owner_id: 'u1', project_id: null, project_name: null, kind: 'note', source_id: 'n1', chunk_index: 0, title: 'T', text: 'Decisão: x', trust: 'derived', status: 'superseded', expires_at: null, supersedes: null, created_at: '2026-09-26T00:00:00.000Z' },
    ]);
    const res = await build(kind, repos).inject({ method: 'PUT', url: '/chat/notes/n1/status', payload: { status: 'superseded', superseded_by: 'decision:d2' } });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryStatus.setStatus).toHaveBeenCalledWith('u1', { kind: 'note', id: 'n1' }, 'superseded', { kind: 'decision', id: 'd2' });
    expect(noteStatusResponse.parse(res.json()).note).toMatchObject({ id: 'n1', status: 'superseded', superseded_by: { ref: 'decision:d2', title: 'Nova?' } });
  });

  it('PUT .../status refuses superseded without a replacement, a bad ref, and an unknown status', async () => {
    const repos = fakeRepos();
    const app = build(kind, repos);
    for (const payload of [{ status: 'superseded' }, { status: 'superseded', superseded_by: 'task:x' }, { status: 'gone' }]) {
      expect((await app.inject({ method: 'PUT', url: '/chat/decisions/d1/status', payload })).statusCode).toBe(400);
    }
    expect(repos.memoryStatus.setStatus).not.toHaveBeenCalled();
  });

  it('PUT .../status answers 404 for someone else\'s item and maps the replacement refusals', async () => {
    const repos = fakeRepos();
    const app = build(kind, repos);
    repos.memoryStatus.setStatus.mockResolvedValueOnce('not_found');
    expect((await app.inject({ method: 'PUT', url: '/chat/decisions/d1/status', payload: { status: 'outdated' } })).statusCode).toBe(404);
    repos.memoryStatus.setStatus.mockResolvedValueOnce('self');
    expect((await app.inject({ method: 'PUT', url: '/chat/decisions/d1/status', payload: { status: 'superseded', superseded_by: 'decision:d1' } })).statusCode).toBe(400);
    repos.memoryStatus.setStatus.mockResolvedValueOnce('replacement_taken');
    const taken = await app.inject({ method: 'PUT', url: '/chat/decisions/d1/status', payload: { status: 'superseded', superseded_by: 'note:n2' } });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe('REPLACEMENT_TAKEN');
  });

  it('GET /memory/replacements offers current items only, never the one being marked', async () => {
    const repos = fakeRepos();
    repos.chatDecisions.listForUser.mockResolvedValueOnce({
      items: [decisionRow({ id: 'd1' }), decisionRow({ id: 'd2', status: 'wrong' }), decisionRow({ id: 'd3', created_at: '2026-09-28T00:00:00.000Z' })],
      next_cursor: null,
    });
    repos.memoryItems.listNotes.mockResolvedValueOnce({
      items: [{ id: 'n1', project_id: null, project_name: null, kind: 'note', title: 'Nota', text: 'Decisão: y', status: 'current', created_at: '2026-09-27T00:00:00.000Z' }],
      next_cursor: null,
    });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/memory/replacements?q=abc&exclude=decision:d1' });
    expect(res.statusCode).toBe(200);
    expect(repos.chatDecisions.listForUser).toHaveBeenCalledWith('u1', expect.objectContaining({ q: 'abc' }));
    const body = memoryReplacementsResponse.parse(res.json());
    expect(body.items.map((i) => i.ref)).toEqual(['decision:d3', 'note:n1']);
    expect(body.items[1]).toMatchObject({ kind: 'note', title: 'Nota', detail: 'y' });
  });

  it('DELETE /notes/:id calls deleteNote scoped to this user and answers 204 whether or not it existed (another user\'s note, or a non-note item, survive)', async () => {
    const repos = fakeRepos();
    repos.memoryItems.deleteNote.mockResolvedValueOnce(true);
    const res1 = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/notes/n1' });
    expect(res1.statusCode).toBe(204);
    expect(repos.memoryItems.deleteNote).toHaveBeenCalledWith('n1', 'u1');

    const repos2 = fakeRepos();
    repos2.memoryItems.deleteNote.mockResolvedValueOnce(false);
    const res2 = await build(kind, repos2).inject({ method: 'DELETE', url: '/chat/notes/other' });
    expect(res2.statusCode).toBe(204);
  });

  it('GET /lessons passes the user, q, cursor and the fixed page size, and maps a file lesson (spec §6/§8)', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listLessons.mockResolvedValueOnce({ items: [lessonItem()], next_cursor: 'CURSOR' });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/lessons?q=migrate&cursor=xyz' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.listLessons).toHaveBeenCalledWith('u1', { q: 'migrate', projectId: undefined, cursor: 'xyz', limit: 50 });
    expect(res.json()).toEqual({
      lessons: [
        {
          id: 'l1',
          project: { id: 'p1', name: 'Proj' },
          title: 'P3009: migrate found failed migrations',
          excerpt: 'Causa: ...\nCorreção: ...',
          origin: 'file',
          path: 'docs/lessons/2026-09-27-x.md',
          ai_memory: null,
          tab_id: null,
          card: 'TER-57',
          pr: 'https://github.com/x/y/pull/169',
          evidence: 'fixed',
          verified: false,
          verified_at: null,
          created_at: '2026-09-27T00:00:00.000Z',
        },
      ],
      next_cursor: 'CURSOR',
    });
    // What the phone parses (`@termhub/mobile-api`).
    if (kind === 'mobile') {
      const parsed = lessonListSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('GET /lessons defaults evidence to observed and path/tab_id/card/pr to null when meta is missing', async () => {
    const repos = fakeRepos();
    repos.memoryItems.listLessons.mockResolvedValueOnce({ items: [lessonItem({ meta: null, project_id: null, project_name: null })], next_cursor: null });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/lessons' });
    expect(res.statusCode).toBe(200);
    const lesson = res.json().lessons[0];
    expect(lesson.project).toBeNull();
    expect(lesson.evidence).toBe('observed');
    expect(lesson.path).toBeNull();
    expect(lesson.tab_id).toBeNull();
    expect(lesson.card).toBeNull();
    expect(lesson.pr).toBeNull();
  });

  it('GET /lessons?project_id checks ownership through scoped(...).project, and passes it through', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/lessons?project_id=p1' });
    expect(res.statusCode).toBe(200);
    expect(repos.projects.findById).toHaveBeenCalledWith('p1');
    expect(repos.memoryItems.listLessons).toHaveBeenCalledWith('u1', { q: undefined, projectId: 'p1', cursor: undefined, limit: 50 });
  });

  it('GET /lessons?project_id of another owner is a 404, never an empty list silently', async () => {
    const repos = fakeRepos();
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/lessons?project_id=other' });
    expect(res.statusCode).toBe(404);
    expect(repos.memoryItems.listLessons).not.toHaveBeenCalled();
  });

  it('POST /lessons/:id/verify verifies this user\'s own lesson and returns it verified', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem());
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem({ verified: true, verified_at: '2026-09-27T01:00:00.000Z' }));
    const res = await build(kind, repos).inject({ method: 'POST', url: '/chat/lessons/l1/verify' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.setVerified).toHaveBeenCalledWith('l1', 'u1', 'u1');
    expect(res.json()).toMatchObject({ verified: true, verified_at: '2026-09-27T01:00:00.000Z' });
    // What the phone parses (`@termhub/mobile-api`).
    if (kind === 'mobile') {
      const parsed = lessonItemSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('POST /lessons/:id/verify on someone else\'s id (or a non-lesson) is a 404, never a 403', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(null);
    const res = await build(kind, repos).inject({ method: 'POST', url: '/chat/lessons/other/verify' });
    expect(res.statusCode).toBe(404);
    expect(repos.memoryItems.setVerified).not.toHaveBeenCalled();
  });

  it('DELETE /lessons/:id/verify unverifies this user\'s own lesson and returns it unverified', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem({ verified: true, verified_at: '2026-09-27T01:00:00.000Z' }));
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem());
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/l1/verify' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.clearVerified).toHaveBeenCalledWith('l1', 'u1');
    expect(res.json()).toMatchObject({ verified: false, verified_at: null });
    // What the phone parses (`@termhub/mobile-api`).
    if (kind === 'mobile') {
      const parsed = lessonItemSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('DELETE /lessons/:id/verify on someone else\'s id (or a non-lesson) is a 404, never a 403', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(null);
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/other/verify' });
    expect(res.statusCode).toBe(404);
    expect(repos.memoryItems.clearVerified).not.toHaveBeenCalled();
  });

  it('DELETE /lessons/:id on a note lesson removes the block, deletes the items and re-indexes the note', async () => {
    const repos = fakeRepos();
    const item = lessonItem({ source_id: 'note:p1:l2', meta: { evidence: 'observed', card: null, pr: null, tags: [], agent: null, tab_id: 't1', origin: 'note', path: null } });
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(item);
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/l1' });
    expect(res.statusCode).toBe(200);
    expect(repos.notes.removeBlock).toHaveBeenCalledWith('p1', 'l2');
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', ['note:p1:l2']);
    expect(repos.memoryItems.hideSource).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(indexProjectNote).toHaveBeenCalledWith(repos, 'p1', expect.anything()));
    // What the phone parses (`@termhub/mobile-api`).
    if (kind === 'mobile') {
      const parsed = lessonForgetSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('DELETE /lessons/:id on a note lesson whose block is already gone from the note still deletes the items and succeeds', async () => {
    const repos = fakeRepos();
    repos.notes.removeBlock.mockResolvedValueOnce(null);
    const item = lessonItem({ source_id: 'note:p1:l2', meta: { evidence: 'observed', card: null, pr: null, tags: [], agent: null, tab_id: 't1', origin: 'note', path: null } });
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(item);
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/l1' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.deleteBySource).toHaveBeenCalledWith('lesson', ['note:p1:l2']);
    expect(res.json()).toEqual({ ok: true });
  });

  it('DELETE /lessons/:id on a file lesson hides it and warns the file stays in the repository', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem());
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/l1' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.hideSource).toHaveBeenCalledWith('l1', 'u1');
    expect(repos.notes.removeBlock).not.toHaveBeenCalled();
    expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ ok: true, note: 'O arquivo continua no repositório; apague-o por um PR para sumir de vez' });
    // What the phone parses (`@termhub/mobile-api`).
    if (kind === 'mobile') {
      const parsed = lessonForgetSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('GET /lessons shows an ai-memory lesson (TER-1021) as file to older apps, with its machine and kind in ai_memory', async () => {
    const repos = fakeRepos();
    const meta = { evidence: 'observed', card: null, pr: null, tags: ['rule'], agent: null, tab_id: null, origin: 'ai-memory', path: 'termhub/_rules/a.md', machine_id: 'm1', machine_name: 'hulk', ai_memory_kind: 'rule' };
    repos.memoryItems.listLessons.mockResolvedValueOnce({ items: [lessonItem({ meta, source_id: 'L1:ai-memory/termhub/_rules/a.md' })], next_cursor: null });
    const res = await build(kind, repos).inject({ method: 'GET', url: '/chat/lessons' });
    expect(res.json().lessons[0]).toMatchObject({ origin: 'file', path: 'termhub/_rules/a.md', ai_memory: { machine_name: 'hulk', kind: 'rule' }, verified: false });
    if (kind === 'mobile') {
      const parsed = lessonListSchema.safeParse(res.json());
      expect(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues)).toBe(true);
    }
  });

  it('DELETE /lessons/:id on an ai-memory lesson hides it and says the page stays on the machine', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(lessonItem({ meta: { evidence: 'observed', card: null, pr: null, tags: [], agent: null, tab_id: null, origin: 'ai-memory', path: 'p/gotchas/a.md' } }));
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/l1' });
    expect(res.statusCode).toBe(200);
    expect(repos.memoryItems.hideSource).toHaveBeenCalledWith('l1', 'u1');
    expect(repos.memoryItems.deleteBySource).not.toHaveBeenCalled();
    expect(res.json()).toEqual({ ok: true, note: 'A página continua no ai-memory da máquina; se ela mudar, volta como lição não verificada' });
  });

  it('DELETE /lessons/:id on someone else\'s id (or a non-lesson) is a 404, never a 403', async () => {
    const repos = fakeRepos();
    repos.memoryItems.findLessonForOwner.mockResolvedValueOnce(null);
    const res = await build(kind, repos).inject({ method: 'DELETE', url: '/chat/lessons/other' });
    expect(res.statusCode).toBe(404);
    expect(repos.memoryItems.hideSource).not.toHaveBeenCalled();
    expect(repos.notes.removeBlock).not.toHaveBeenCalled();
  });
});
