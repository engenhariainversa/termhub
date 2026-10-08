import { describe, expect, it } from 'vitest';
import { ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';
import { decideLine, fixerPrompt, implementerPrompt, integratorPrompt, RESUME_TEXT, SERVER_MARKER, serverMessage, SHELL_LINE } from './prompts.js';

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
  it('tell every role to decide by itself and record it, never ending on a question (TER-1043)', () => {
    const [implementer, integrator, ...fixers] = all(null);
    expect(implementer).toContain(decideLine('pr'));
    for (const p of [integrator!, ...fixers]) expect(p).toContain(decideLine('report'));
    for (const p of [...all(null), ...all(custom)]) {
      expect(p).toContain('o precedente da pessoa (search_memory) ou a sua recomendação');
      expect(p).toContain('Nunca termine o turno com uma pergunta');
      expect(p).not.toContain('Pare e pergunte');
    }
    expect(decideLine('pr')).toMatchSnapshot();
    expect(decideLine('report')).toMatchSnapshot();
  });
  it('keep the old "pare e pergunte" line when the project stops on decisions (TER-1043)', () => {
    const p = implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null, description: null, stopOnDecisions: true });
    expect(p).toContain('Pare e pergunte só quando a decisão não estiver no card');
    expect(p).not.toContain(decideLine('pr'));
    expect(fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci', detail: 'x', custom: null, stopOnDecisions: true })).not.toContain(decideLine('report'));
  });
  it('marks server messages', () => {
    expect(serverMessage('oi')).toBe('[termhub automático] oi');
    expect(RESUME_TEXT).toContain('report_card');
  });
});
