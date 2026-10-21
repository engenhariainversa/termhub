import { describe, expect, it } from 'vitest';
import { CLAUDE_MODEL_ALIASES, CLAUDE_MODEL_ALIAS_LIST, MODEL_ID_EXAMPLE, MODEL_RE, isClaudeModelAlias } from './models.js';

describe('CLAUDE_MODEL_ALIASES', () => {
  it('offers every family the CLI resolves itself, Fable included, in the CLI help order', () => {
    expect(CLAUDE_MODEL_ALIASES).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(CLAUDE_MODEL_ALIAS_LIST).toBe('fable, opus, sonnet, haiku');
  });

  it('is a list of plain words the CLI and the shell both take as they are', () => {
    for (const a of CLAUDE_MODEL_ALIASES) expect(a, a).toMatch(/^[a-z]+$/);
    expect(new Set(CLAUDE_MODEL_ALIASES).size).toBe(CLAUDE_MODEL_ALIASES.length);
  });

  it('points the free-id field at a full id that passes the model rule', () => {
    expect(MODEL_ID_EXAMPLE.claude).toBe('claude-fable-5-1');
    for (const id of Object.values(MODEL_ID_EXAMPLE)) expect(MODEL_RE.test(id), id).toBe(true);
  });
});

describe('isClaudeModelAlias', () => {
  it('knows the aliases, with or without a context suffix', () => {
    for (const m of ['fable', 'opus', 'sonnet', 'haiku', 'sonnet[1m]', 'fable[1m]']) expect(isClaudeModelAlias(m), m).toBe(true);
  });

  it('is false for full ids, other CLIs and look-alikes', () => {
    for (const m of ['claude-fable-5-1', 'claude-opus-5-5', 'gpt-5-codex', 'opusplan2', 'Fable', 'fable ', '']) expect(isClaudeModelAlias(m), m).toBe(false);
  });
});

describe('MODEL_RE', () => {
  it('takes aliases and full ids, refuses what the shell or the CLI would read', () => {
    for (const m of ['opus', 'sonnet[1m]', 'claude-fable-5-1', 'us.anthropic.claude-haiku-4-5', 'gpt-5-codex']) expect(MODEL_RE.test(m), m).toBe(true);
    for (const m of ['-opus', 'opus 4', 'x;id', '$(id)', '', 'a'.repeat(101)]) expect(MODEL_RE.test(m), m).toBe(false);
  });
});
