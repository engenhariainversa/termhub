import { describe, expect, it } from 'vitest';
import { claudeTools, codexSandbox, providerOfModel, resolveModel } from './models.js';

const ctx = (blocked: string[] = [], chatgpt: string | null = null) => ({ blocked, setupModels: { claude: null, chatgpt } });

describe('claudeTools', () => {
  it('reads always, edits with edit, runs commands with run_commands', () => {
    expect(claudeTools(['read'])).toEqual(['Read', 'Grep', 'Glob']);
    expect(claudeTools(['read', 'edit'])).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write']);
    expect(claudeTools(['read', 'run_commands'])).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(claudeTools(['edit', 'run_commands'])).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  });
});

describe('codexSandbox', () => {
  it('is read-only unless the run edits or runs commands', () => {
    expect(codexSandbox(['read'])).toBe('read-only');
    expect(codexSandbox([])).toBe('read-only');
    expect(codexSandbox(['read', 'edit'])).toBe('workspace-write');
    expect(codexSandbox(['run_commands'])).toBe('workspace-write');
  });
});

describe('resolveModel', () => {
  it('maps the Claude classes, default when none is given', () => {
    expect(resolveModel('claude', { model_class: 'fast' }, ctx())).toBe('haiku');
    expect(resolveModel('claude', { model_class: 'default' }, ctx())).toBe('sonnet');
    expect(resolveModel('claude', { model_class: 'strong' }, ctx())).toBe('opus');
    expect(resolveModel('claude', {}, ctx())).toBe('sonnet');
  });

  it('falls back through conciergeModel when the family is blocked', () => {
    expect(resolveModel('claude', { model_class: 'strong' }, ctx(['opus']))).toBe('sonnet');
    expect(resolveModel('claude', { model_class: 'fast' }, ctx(['haiku']))).toBe('opus');
    expect(resolveModel('claude', { model_class: 'default' }, ctx(['fable']))).toBe('sonnet');
  });

  it('keeps an explicit Claude model unless its family is blocked', () => {
    expect(resolveModel('claude', { model: 'claude-opus-5-5' }, ctx())).toBe('claude-opus-5-5');
    expect(resolveModel('claude', { model: 'claude-fable-5-1', model_class: 'fast' }, ctx(['fable']))).toBe('opus');
  });

  it('uses the Setup chatgpt model for Codex default/strong and the CLI default otherwise', () => {
    expect(resolveModel('codex', { model_class: 'default' }, ctx([], 'gpt-5-codex'))).toBe('gpt-5-codex');
    expect(resolveModel('codex', { model_class: 'strong' }, ctx([], 'gpt-5-codex'))).toBe('gpt-5-codex');
    expect(resolveModel('codex', {}, ctx([], 'gpt-5-codex'))).toBe('gpt-5-codex');
    expect(resolveModel('codex', { model_class: 'fast' }, ctx([], 'gpt-5-codex'))).toBeNull();
    expect(resolveModel('codex', { model_class: 'default' }, ctx())).toBeNull();
    expect(resolveModel('codex', { model: 'gpt-6-astra' }, ctx(['opus'], 'gpt-5-codex'))).toBe('gpt-6-astra');
  });
});

describe('providerOfModel', () => {
  it('tells Claude ids and aliases from OpenAI ids', () => {
    expect(providerOfModel('gpt-6-astra')).toBe('codex');
    expect(providerOfModel('o4-mini')).toBe('codex');
    expect(providerOfModel('codex-mini-latest')).toBe('codex');
    expect(providerOfModel('sonnet')).toBe('claude');
    expect(providerOfModel('sonnet[1m]')).toBe('claude');
    expect(providerOfModel('claude-opus-5-5')).toBe('claude');
    expect(providerOfModel('opusplan')).toBe('claude');
    expect(providerOfModel('llama-4')).toBeNull();
    expect(providerOfModel('')).toBeNull();
  });
});
