import { describe, expect, it } from 'vitest';
import { ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';
import { rulesBlock } from '../memory/current-rules.js';
import { fixerPrompt, GITHUB_LINE, implementerPrompt, integratorPrompt, RESUME_TEXT, SERVER_MARKER, serverMessage, SHELL_LINE } from './prompts.js';

const policy = 'Autonomia do projeto: pr. Você abre o PR e para.\nO merge é feito pelo termhub quando o CI fica verde e a política permite.';
const title = 'T'.repeat(300);
const card = { ref: 'TER-1', url: 'https://x/TER-1', title };
const custom = 'c'.repeat(1200);
const all = (c: string | null, d: string | null = 'd'.repeat(5000)) => [
  implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: c, description: d }),
  integratorPrompt({ epic: card, branch: 'b', base: 'main', prUrl: 'https://x/pr/1', policy, custom: c }),
  fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci', detail: 'x'.repeat(5000), custom: c }),
  fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'conflict', detail: 'y', custom: c }),
];

describe('prompts', () => {
  it('stay under the cap with the origin reminder, at the maximum of everything', () => {
    for (const p of all(custom)) expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(implementerPrompt({ card, branch: 'b', base: 'main', policy: 'p'.repeat(5000), custom, description: 'd'.repeat(5000) }).length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });
  it("TER-1011: every role carries the project's current rules, and stays under the cap with them", () => {
    const rules = rulesBlock([{ ref: 'note:n2', title: 'Modo de permissão', decision: 'modo auto', project_id: 'p1' }])!;
    const prompts = [
      implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null, description: 'd'.repeat(5000), rules }),
      integratorPrompt({ epic: card, branch: 'b', base: 'main', prUrl: 'u', policy, custom: null, rules }),
      fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci', detail: 'x'.repeat(5000), custom: null, rules }),
    ];
    for (const p of prompts) {
      expect(p).toContain('- [note:n2] «Modo de permissão»: «modo auto»');
      expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    }
    const big = rulesBlock(Array.from({ length: 20 }, (_, i) => ({ ref: `note:n${i}`, title: `t${i}`, decision: 'x'.repeat(200), project_id: 'p1' })))!;
    expect(implementerPrompt({ card, branch: 'b', base: 'main', policy: 'p'.repeat(5000), custom, description: 'd'.repeat(5000), rules: big }).length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null })).not.toContain('Regras vigentes');
  });

  it('never forbid merging absolutely', () => {
    for (const p of [...all(null), ...all(custom)]) expect(p).not.toMatch(/não faça merge|do not merge/i);
  });
  it('name report_card and the marker, and the implementer carries the policy even with custom text', () => {
    for (const p of all(null)) { expect(p).toContain('report_card'); expect(p).toContain(SERVER_MARKER); }
    const p = implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: 'faça do meu jeito', description: null });
    expect(p).toContain(policy);
    expect(p).toContain('faça do meu jeito');
    expect(p).toContain('report_card com status done');
    expect(p).not.toContain('Leia o card');
    expect(integratorPrompt({ epic: card, branch: 'b', base: 'main', prUrl: 'u', policy, custom: 'z' })).toContain(policy);
  });
  it('tell every role not to chain several cd in one command, even with custom text (TER-989)', () => {
    for (const p of [...all(null), ...all(custom)]) expect(p).toContain(SHELL_LINE);
    expect(SHELL_LINE).toMatch(/sem vários cd/);
    expect(SHELL_LINE).toMatch(/parênteses/);
    expect(SHELL_LINE).toMatch(/heredoc/);
    expect(SHELL_LINE).toContain('não /bin/ls');
  });
  it('tell every role the cwd is already the worktree, so git needs no -C (TER-991)', () => {
    expect(SHELL_LINE).toContain('O diretório atual já é a worktree');
    expect(SHELL_LINE).toContain('sem git -C');
    expect(SHELL_LINE).toContain('não sed -i');
  });
  it('carries the description excerpt and the lessons reminder', () => {
    const p = implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null, description: 'Faça o X' });
    expect(p).toContain('Faça o X');
    expect(p).toContain('docs/lessons/');
  });
  it('marks server messages', () => {
    expect(serverMessage('oi')).toBe('[termhub automático] oi');
    expect(RESUME_TEXT).toContain('report_card');
  });
  it('tell every role to hand a GitHub error to termhub (github_transient) when there is room (TER-1025)', () => {
    for (const p of all(null)) expect(p).toContain(GITHUB_LINE);
    expect(GITHUB_LINE).toContain('github_transient');
    // at the maximum of everything the line gives way: report_card's description carries the same rule
    for (const p of all(custom)) expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });
});
