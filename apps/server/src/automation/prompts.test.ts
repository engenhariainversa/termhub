import { describe, expect, it } from 'vitest';
import { ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';
import { fixerPrompt, implementerPrompt, integratorPrompt, RESUME_TEXT, SERVER_MARKER, serverMessage } from './prompts.js';

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
  it('carries the description excerpt and the lessons reminder', () => {
    const p = implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null, description: 'Faça o X' });
    expect(p).toContain('Faça o X');
    expect(p).toContain('docs/lessons/');
  });
  it('marks server messages', () => {
    expect(serverMessage('oi')).toBe('[termhub automático] oi');
    expect(RESUME_TEXT).toContain('report_card');
  });
});
