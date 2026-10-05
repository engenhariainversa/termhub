import { describe, expect, it, vi } from 'vitest';
import { hashApiToken, API_TOKEN_RE } from '../auth/api-tokens.js';
import { ControlError, type ControlContext } from '../control/context.js';
import type { Repositories } from '../db/repositories/index.js';
import { mintTabToken, pinTabArgs, TAB_EXCLUDED_KINDS, TAB_TOKEN_SCOPES, TAB_TOKEN_TOOLS, TAB_TOKEN_TTL_MS, tabInputShape, tabRefusalMessage, tabTokenName } from './tab-token.js';
import { allowedTools } from './tools.js';
import { z } from 'zod';

const tab = { id: 'tab1', project_id: 'p1' };

describe('constants', () => {
  it('pins the allowlist, scopes, excluded kinds and TTL of the spec (D2, D3, D6)', () => {
    expect(TAB_TOKEN_TOOLS).toEqual(['search_memory', 'record_lesson', 'get_automation_policy', 'report_card', 'get_card']);
    expect(TAB_TOKEN_SCOPES).toEqual(['read', 'memory']);
    expect(TAB_EXCLUDED_KINDS).toEqual(['message', 'action']);
    expect(TAB_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

it('a tab token lists get_automation_policy', () => expect(TAB_TOKEN_TOOLS).toContain('get_automation_policy'));

describe('tabTokenName', () => {
  it('names the token after the tab', () => {
    expect(tabTokenName('claude')).toBe('aba «claude» (automático)');
  });

  it('cuts the tab name to 60 chars', () => {
    expect(tabTokenName('x'.repeat(100))).toBe(`aba «${'x'.repeat(60)}» (automático)`);
  });
});

describe('pinTabArgs', () => {
  it('fills project_id and tab_id when the tool declares them and they are absent', () => {
    expect(pinTabArgs(tab, { query: 'q' }, ['query', 'project_id', 'tab_id'])).toEqual({ query: 'q', project_id: 'p1', tab_id: 'tab1' });
  });

  it('keeps the same project_id and tab_id', () => {
    expect(pinTabArgs(tab, { project_id: 'p1', tab_id: 'tab1' }, ['project_id', 'tab_id'])).toEqual({ project_id: 'p1', tab_id: 'tab1' });
  });

  it('refuses another project with TAB_SCOPE', () => {
    let err: unknown;
    try {
      pinTabArgs(tab, { project_id: 'p2' }, ['project_id']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ControlError);
    expect(err).toMatchObject({ code: 'TAB_SCOPE', message: 'O token desta aba só acessa o projeto da aba' });
  });

  it('refuses another tab with TAB_SCOPE', () => {
    expect(() => pinTabArgs(tab, { tab_id: 'tab2' }, ['tab_id'])).toThrow(new ControlError('TAB_SCOPE', 'O token desta aba só age em nome da própria aba'));
  });

  it('refuses a different value even when the tool does not declare the key', () => {
    expect(() => pinTabArgs(tab, { project_id: 'p2' }, ['query'])).toThrow(/projeto da aba/);
  });

  it('never adds a key the tool does not declare', () => {
    expect(pinTabArgs(tab, { query: 'q' }, ['query'])).toEqual({ query: 'q' });
  });

  it('does not mutate the arguments it was given', () => {
    const args = { query: 'q' };
    pinTabArgs(tab, args, ['query', 'project_id']);
    expect(args).toEqual({ query: 'q' });
  });
});

describe('tabInputShape', () => {
  it('makes a declared project_id and tab_id optional and leaves every other key as it was', () => {
    const text = z.string().min(1);
    const shape = { project_id: z.string().min(1), tab_id: z.string().min(1), text };
    const view = z.object(tabInputShape(shape));
    expect(view.safeParse({ text: 'x' }).success).toBe(true);
    expect(view.safeParse({}).success).toBe(false);
    expect(view.safeParse({ text: 'x', project_id: '' }).success).toBe(false);
    expect(tabInputShape(shape).text).toBe(text);
    expect(z.object(shape).safeParse({ text: 'x' }).success).toBe(false);
    expect(Object.keys(tabInputShape({ query: text }))).toEqual(['query']);
  });
});

describe('tabRefusalMessage', () => {
  it('says the tab token only reaches the memory tools', () => {
    expect(tabRefusalMessage('list_tabs')).toContain('list_tabs');
    expect(tabRefusalMessage('x'.repeat(100))).not.toContain('x'.repeat(65));
  });

  it('names the run-only tools as such, and says a run-only tool needs a tab with automatic work (F-8)', () => {
    expect(tabRefusalMessage('list_tabs')).toBe(
      'O token desta aba só usa as ferramentas permitidas (search_memory, record_lesson, get_automation_policy, e report_card e get_card numa aba com trabalho automático); list_tabs não está disponível aqui',
    );
    expect(tabRefusalMessage('report_card')).toBe('report_card só está disponível numa aba com trabalho automático em andamento');
    expect(tabRefusalMessage('get_card', 'en')).toBe('get_card is only available in a tab running automatic work');
  });
});

describe('mintTabToken', () => {
  it('creates an ungated read+memory token for the tab, expiring in 30 days, and hands back the plain token', async () => {
    const create = vi.fn(async () => ({ id: 'tok9' }));
    const repos = { apiTokens: { create } } as unknown as Repositories;
    const before = Date.now();
    const out = await mintTabToken(repos, 'u1', { id: 'tab1', name: 'claude' });
    expect(out.id).toBe('tok9');
    expect(out.token).toMatch(API_TOKEN_RE);
    expect(create).toHaveBeenCalledTimes(1);
    const [userId, input, hash] = create.mock.calls[0] as unknown as [string, { name: string; scopes: string[]; expiresAt: Date; gated: boolean; tabId: string }, string];
    expect(userId).toBe('u1');
    expect(hash).toBe(hashApiToken(out.token));
    expect(input).toMatchObject({ name: 'aba «claude» (automático)', scopes: ['read', 'memory'], gated: false, tabId: 'tab1' });
    expect(input.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TAB_TOKEN_TTL_MS);
    expect(input.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TAB_TOKEN_TTL_MS);
  });
});

describe('allowedTools for a tab token', () => {
  const ctxWith = (tokenTab?: { id: string; project_id: string }): ControlContext =>
    ({ can: async () => true, token: { id: 't', scopes: ['read', 'memory', 'tasks', 'terminals'], tab: tokenTab } }) as unknown as ControlContext;

  it('keeps only the allowlisted tools that exist, even with every scope and grant', async () => {
    const names = (await allowedTools(ctxWith(tab), ['read', 'memory', 'tasks', 'terminals'])).map((t) => t.name);
    expect(names).toContain('search_memory');
    expect(names.every((n) => (TAB_TOKEN_TOOLS as readonly string[]).includes(n))).toBe(true);
  });

  it('lists record_lesson only when that tool is registered, with no error when it is not', async () => {
    const { TOOLS } = await import('./tools.js');
    const names = (await allowedTools(ctxWith(tab), ['read', 'memory'])).map((t) => t.name);
    expect(names.includes('record_lesson')).toBe(TOOLS.some((t) => t.name === 'record_lesson'));
  });

  it('leaves a token without a tab untouched', async () => {
    const names = (await allowedTools(ctxWith(undefined), ['read', 'memory'])).map((t) => t.name);
    expect(names).toContain('list_tabs');
    expect(names).toContain('record_decision');
    // the run-only tab tools never reach an ordinary token, whatever its scopes and grants
    expect(names).not.toContain('report_card');
    expect(names).not.toContain('get_card');
  });

  it('lists report_card and get_card only for a tab whose own tab has an active automatic run (F-8)', async () => {
    const withRun = (run: { project_id: string } | null): ControlContext =>
      ({ ...ctxWith(tab), repos: { automationRuns: { activeByTab: async (id: string) => (id === 'tab1' ? run : null) } } }) as unknown as ControlContext;
    const listed = async (ctx: ControlContext) => (await allowedTools(ctx, ['read', 'memory'])).map((t) => t.name);
    expect(await listed(withRun({ project_id: 'p1' }))).toEqual(expect.arrayContaining(['report_card', 'get_card']));
    expect(await listed(withRun(null))).not.toContain('report_card');
    expect(await listed(withRun({ project_id: 'other' }))).not.toContain('get_card');
    // the condition fails closed: no repository answer, no tool
    expect(await listed(ctxWith(tab))).not.toContain('report_card');
  });
});
