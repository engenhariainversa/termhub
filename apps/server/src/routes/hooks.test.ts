import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Tab } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { monitorBus } from '../monitor/bus.js';
import { hashHookToken, newHookToken } from '../monitor/token.js';
import { recordInputOrigin, resetInputOrigins } from '../terminal/input-origin.js';
import { hooksRoutes } from './hooks.js';

const { token, hash } = newHookToken();
const tab: Tab = { id: 'tab1', project_id: 'p1', machine_id: 'm1', name: 'x', kind: 'terminal', tmux_session: 'termhub-p1-tab1', simulator_udid: null, position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, created_at: '2026-09-18T00:00:00.000Z' };

function buildApp(logStream?: { write(line: string): void }) {
  const recordEvent = vi.fn(async (_id: string, e: { kind: Tab['state']; tool: string; text: string | null }) => ({
    tab: { ...tab, state: e.kind, state_text: e.text, state_tool: e.tool, state_at: '2026-09-18T10:00:00.000Z' },
    event: { id: 'e1', tab_id: tab.id, kind: e.kind, tool: e.tool, text: e.text, meta: {}, created_at: '2026-09-18T10:00:00.000Z' },
  }));
  const repos = {
    machineHooks: { machineIdForTokenHash: async (h: string) => (h === hash ? 'm1' : undefined) },
    tabs: { findByTmuxSession: async (machineId: string, session: string) => (machineId === 'm1' && session === tab.tmux_session ? tab : undefined), recordEvent },
    machines: { findById: async (id: string) => (id === 'm1' ? { id: 'm1', owner_id: 'u1' } : undefined) },
    users: { findById: async (id: string) => (id === 'u1' ? { id, name: 'Pedro' } : undefined) },
    chat: { findUserMessagesForUser: async () => [] },
  } as unknown as Repositories;
  const app = Fastify(logStream ? { logger: { level: 'debug', stream: logStream } } : {});
  applyErrorHandler(app);
  app.register((instance) => hooksRoutes(instance, repos), { prefix: '/api/hooks' });
  return { app, recordEvent };
}

const post = (app: ReturnType<typeof Fastify>, payload: unknown, auth = `Bearer ${token}`) =>
  app.inject({ method: 'POST', url: '/api/hooks/events', payload: payload as Record<string, unknown>, headers: { authorization: auth } });

describe('POST /api/hooks/events', () => {
  it('rejects a missing, malformed or unknown token', async () => {
    const { app } = buildApp();
    expect((await post(app, {}, '')).statusCode).toBe(401);
    expect((await post(app, {}, 'Bearer nope')).statusCode).toBe(401);
    expect((await post(app, {}, `Bearer thb_hk_${'a'.repeat(43)}`)).statusCode).toBe(401);
  });

  it('records the interpreted event as the tab state and publishes it', async () => {
    const { app, recordEvent } = buildApp();
    const published: unknown[] = [];
    const off = monitorBus.subscribe((c) => published.push(c));
    const r = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Allow Bash?' } });
    off();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, tab_id: 'tab1', state: 'waiting_permission' });
    expect(recordEvent).toHaveBeenCalledWith('tab1', { kind: 'waiting_permission', tool: 'claude', text: 'Allow Bash?', meta: { event: 'Notification', type: 'permission_prompt' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ owner_id: 'u1', machine_id: 'm1', project_id: 'p1' });
  });

  it('tells the repository which event continues the wait before it, and only that one', async () => {
    const { app, recordEvent } = buildApp();
    await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' } });
    await post(app, { tool: 'codex', session: tab.tmux_session, event: { type: 'agent-turn-complete', 'last-assistant-message': 'dois' } });
    expect(recordEvent.mock.calls.map((c) => (c[1] as { continuesWait?: boolean }).continuesWait)).toEqual([true, undefined]);
  });

  it('ignores the turn Codex runs to title the conversation: the tab keeps its answer', async () => {
    const { app, recordEvent } = buildApp();
    const r = await post(app, { tool: 'codex', session: tab.tmux_session, event: { type: 'agent-turn-complete', 'thread-id': 'side', 'input-messages': ['Generate a concise, single-line task title of at most 36 characters…\n\nresponda apenas: um'], 'last-assistant-message': '{"title":"Responder apenas um"}' } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ ok: false, reason: 'ignored' });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('carries a plain spinner verb to the tab and drops anything else without refusing the event', async () => {
    const { app, recordEvent } = buildApp();
    const ok = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: 'Moonwalking' } });
    expect(ok.statusCode).toBe(200);
    expect(recordEvent).toHaveBeenLastCalledWith('tab1', expect.objectContaining({ kind: 'working', activity: 'coding', activityVerb: 'Moonwalking' }));
    const hostile = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'PreToolUse', tool_name: 'Edit', verb: '<img src=x onerror=alert(1)>' } });
    expect(hostile.statusCode).toBe(200);
    expect(recordEvent).toHaveBeenLastCalledWith('tab1', expect.objectContaining({ kind: 'working', activity: 'coding', activityVerb: null }));
  });

  it('answers 202 for an unknown session or an event with nothing to show', async () => {
    const { app, recordEvent } = buildApp();
    const unknown = await post(app, { tool: 'claude', session: 'not-a-tab', event: { hook_event_name: 'Stop' } });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual({ ok: false, reason: 'unknown_session' });
    const ignored = await post(app, { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'SubagentStop' } });
    expect(ignored.json()).toEqual({ ok: false, reason: 'ignored' });
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('rejects before reading the body: a bad token with an oversized or invalid body is still a plain 401', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'POST', url: '/api/hooks/events', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, payload: '{not json' });
    expect(r.statusCode).toBe(401);
  });

  it('validates the body', async () => {
    const { app } = buildApp();
    expect((await post(app, { tool: 'vim', session: tab.tmux_session, event: {} })).statusCode).toBe(400);
    expect((await post(app, { tool: 'claude', session: 'bad session!', event: {} })).statusCode).toBe(400);
  });
});

describe('hook tokens', () => {
  it('are prefixed, random and hashed with sha256', () => {
    const a = newHookToken();
    const b = newHookToken();
    expect(a.token.startsWith('thb_hk_')).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashHookToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /api/hooks/events: the origin of a prompt termhub typed (TER-851)', () => {
  const prompt = 'pode fazer o merge do #279 segredo-do-prompt';
  const submit = { tool: 'claude', session: tab.tmux_session, event: { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt } };

  it('answers a matched UserPromptSubmit with the note for the hook to print, once', async () => {
    resetInputOrigins();
    const { app } = buildApp();
    recordInputOrigin(tab.id, prompt, { level: 'assistant', userId: 'u1' });
    const r = await post(app, submit);
    expect(r.statusCode).toBe(200);
    expect(r.body.startsWith('{"hookSpecificOutput"')).toBe(true);
    expect(r.json()).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringMatching(/^termhub origin note: the termhub chat assistant sent this message on its own/) } });
    expect((await post(app, submit)).json()).toEqual({ ok: true, tab_id: 'tab1', state: 'working' });
  });

  it('answers as before when nothing matches', async () => {
    resetInputOrigins();
    const { app } = buildApp();
    recordInputOrigin(tab.id, 'outro texto', { level: 'assistant', userId: 'u1' });
    expect((await post(app, submit)).json()).toEqual({ ok: true, tab_id: 'tab1', state: 'working' });
  });

  it('never answers for a tab of another machine', async () => {
    resetInputOrigins();
    const { app } = buildApp();
    recordInputOrigin(tab.id, prompt, { level: 'assistant', userId: 'u1' });
    const other = await post(app, { ...submit, session: 'termhub-p9-other' });
    expect(other.statusCode).toBe(202);
    expect(other.body).not.toContain('hookSpecificOutput');
  });

  it('never logs the prompt or the note', async () => {
    resetInputOrigins();
    const lines: string[] = [];
    const { app } = buildApp({ write: (line) => lines.push(line) });
    recordInputOrigin(tab.id, prompt, { level: 'person_typed', userId: 'u1', surface: 'web' });
    expect((await post(app, submit)).statusCode).toBe(200);
    const logged = lines.join('');
    expect(logged).toContain('monitor: prompt origin');
    expect(logged).not.toContain('segredo-do-prompt');
    expect(logged).not.toContain('These are their own words');
  });
});
