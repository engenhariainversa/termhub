import { describe, expect, it } from 'vitest';
import type { AiAccount } from '../db/repositories/types.js';
import { accountsOn, isAlias, modelFor, type ProjectAi } from './project-accounts.js';

const acc = (id: string, machine_id: string, provider: AiAccount['provider'] = 'claude'): AiAccount => ({ id, provider, label: id, machine_id, config_dir: null, created_at: '' });
const all = [acc('a1', 'm1'), acc('a2', 'm1'), acc('c1', 'm1', 'chatgpt'), acc('b1', 'm2'), acc('g1', 'm1', 'gemini')];
const ai = (accounts: string[], claude: string | null = null): ProjectAi => ({ accounts, models: { claude, chatgpt: null } });

describe('accountsOn', () => {
  it('keeps the priority order, not the list order', () => {
    expect(accountsOn('p1', ai(['a2', 'a1']), all, 'm1', 'claude').map((a) => a.id)).toEqual(['a2', 'a1']);
  });
  it('drops ids that no longer name an account, and accounts of other machines or providers', () => {
    expect(accountsOn('p1', ai(['gone', 'b1', 'c1', 'a1']), all, 'm1', 'claude').map((a) => a.id)).toEqual(['a1']);
    expect(accountsOn('p1', ai(['gone', 'b1', 'c1', 'a1']), all, 'm1').map((a) => a.id)).toEqual(['c1', 'a1']);
  });
  it('never returns a provider start_agent cannot launch', () => {
    expect(accountsOn('p1', ai(['g1']), all, 'm1')).toEqual([]);
  });
});

describe('modelFor', () => {
  it('is the model of that provider, null for the others', () => {
    expect(modelFor(ai([], 'opus'), 'claude')).toBe('opus');
    expect(modelFor(ai([], 'opus'), 'chatgpt')).toBeNull();
    expect(modelFor(ai([], 'opus'), 'gemini')).toBeNull();
  });
});

describe('isAlias', () => {
  it('knows the aliases every Claude CLI resolves itself', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'sonnet[1m]']) expect(isAlias(m), m).toBe(true);
    for (const m of ['claude-opus-5-5', 'gpt-5-codex', 'opusplan2']) expect(isAlias(m), m).toBe(false);
  });
});
