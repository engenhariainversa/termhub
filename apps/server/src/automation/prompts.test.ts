import { describe, expect, it } from 'vitest';
import { ORIGIN_REMINDER, PROMPT_MAX_CHARS } from '../control/agents.js';
import { rulesBlock } from '../memory/current-rules.js';
import { decideLine, fixerPrompt, GITHUB_LINE, implementerPrompt, integratorPrompt, RESUME_TEXT, SERVER_MARKER, serverMessage, SHELL_LINE, SHELL_LINE_MULTI } from './prompts.js';

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

  it("TER-1110: the implementer and the fixer carry the project's naming rule next to the branch, under the cap", () => {
    const naming = 'Este card vem do ticket APPS-337: cite APPS-337 nos commits e no título do PR. Nunca use a ref DRH-21 do termhub em branch, commit, título ou descrição de PR, nem em nada no GitHub.';
    const prompts = [
      implementerPrompt({ card, branch: 'b', base: 'main', naming, policy: 'p'.repeat(5000), custom, description: 'd'.repeat(5000) }),
      fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', naming, reason: 'ci', detail: 'x'.repeat(5000), custom }),
    ];
    for (const p of prompts) {
      expect(p).toContain(`outro push pede aprovação. ${naming}`);
      expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    }
    expect(implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null })).not.toContain('Nunca use a ref');
  });

  it('multi-repo Task 11: names the card repository only when given, and stays under the cap at the maximum of everything', () => {
    const naming = 'Este card vem do ticket APPS-337: cite APPS-337 nos commits e no título do PR. Nunca use a ref DRH-21 do termhub em branch, commit, título ou descrição de PR, nem em nada no GitHub.';
    const repo = `${'o'.repeat(99)}/${'r'.repeat(100)}`;
    const big = rulesBlock(Array.from({ length: 20 }, (_, i) => ({ ref: `note:n${i}`, title: `t${i}`, decision: 'x'.repeat(200), project_id: 'p1' })))!;
    const named = implementerPrompt({ card, branch: 'b', base: 'main', repo, naming, policy: 'p'.repeat(5000), custom, description: 'd'.repeat(5000), rules: big });
    expect(named).toContain(`Trabalhe no repositório ${repo}, na branch b (base main).`);
    expect(named.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    // a single-repo project: the same text as before, byte for byte
    const plain = { card, branch: 'b', base: 'main', policy, custom: null, description: 'faça isto' };
    expect(implementerPrompt({ ...plain, repo: null })).toBe(implementerPrompt(plain));
    expect(implementerPrompt(plain)).toContain('Trabalhe na branch b (base main).');
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
  it('tell every role to hand a GitHub error to termhub (github_transient) when there is room (TER-1025)', () => {
    for (const p of all(null)) expect(p).toContain(GITHUB_LINE);
    expect(GITHUB_LINE).toContain('github_transient');
    // at the maximum of everything the line gives way: report_card's description carries the same rule
    for (const p of all(custom)) expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
  });

  describe('workspace runs (multi-repo Task 12)', () => {
    const repos = [
      { key: 'api', full_name: 'acme/api', base: 'main' },
      { key: 'web', full_name: 'acme/web', base: 'develop' },
    ];
    const workspace = '/home/u/.termhub/worktrees/p1/TER-1';
    const naming = 'Este card vem do ticket APPS-337: cite APPS-337 nos commits e no título do PR. Nunca use a ref DRH-21 do termhub em branch, commit, título ou descrição de PR, nem em nada no GitHub.';
    const big = rulesBlock(Array.from({ length: 20 }, (_, i) => ({ ref: `note:n${i}`, title: `t${i}`, decision: 'x'.repeat(200), project_id: 'p1' })))!;

    it('names each repository with its folder and base, the exact push form and one PR per repository', () => {
      const p = implementerPrompt({ card, branch: 'TER-1-x', base: 'main', repos, workspace, policy, custom: null, description: 'faça isto' });
      expect(p).toContain('- api: acme/api (base main)');
      expect(p).toContain('- web: acme/web (base develop)');
      expect(p).toContain('abra um PR por repositório com mudança');
      expect(p).toContain(`git -C ${workspace}/<key> push -u origin TER-1-x`);
      expect(p).toContain(SHELL_LINE_MULTI);
      expect(p).not.toContain(SHELL_LINE);
      expect(p).toContain('cd <key> sozinho numa chamada');
      // without the root (a prompt built before the run has a place), the push after a cd sent alone
      expect(fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci', detail: 'x', custom: null, repos })).toContain('rode cd <key> sozinho numa chamada e, na seguinte, git push -u origin b');
      expect(p).toContain('Descrição do card:\nfaça isto');
    });

    it('one repository keeps the single-repo prompt byte for byte', () => {
      const plain = { card, branch: 'b', base: 'main', policy, custom: null, description: 'faça isto' };
      expect(implementerPrompt({ ...plain, repos: [repos[0]!], workspace })).toBe(implementerPrompt(plain));
      expect(implementerPrompt({ ...plain, repos: [] })).toBe(implementerPrompt(plain));
      const fix = { ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci' as const, detail: 'PR x', custom: null };
      expect(fixerPrompt({ ...fix, repos: [repos[0]!], repoKey: 'api' })).toBe(fixerPrompt(fix));
      const integ = { epic: card, branch: 'b', base: 'main', prUrl: 'https://x/pr/1', policy, custom: null };
      expect(integratorPrompt({ ...integ, repos: [repos[0]!] })).toBe(integratorPrompt(integ));
    });

    it('the repository lines take the description room first', () => {
      const d = 'd'.repeat(5000);
      const one = implementerPrompt({ card, branch: 'b', base: 'main', policy, custom: null, description: d });
      const two = implementerPrompt({ card, branch: 'b', base: 'main', repos, workspace, policy, custom: null, description: d });
      const excerpt = (p: string) => p.split('Descrição do card:\n')[1]!.length;
      expect(excerpt(two)).toBeLessThan(excerpt(one));
      expect(two).toContain('- web: acme/web (base develop)');
    });

    it('the fixer is told which repository failed', () => {
      const p = fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'ci', detail: 'PR https://x/pr/2', custom: null, repos, repoKey: 'web', workspace });
      expect(p).toContain('O PR é do repositório da pasta web/.');
      expect(p).toContain('- web: acme/web (base develop) ← o PR com problema');
      expect(p).toContain(`git -C ${workspace}/<key> push -u origin b`);
      expect(p).toContain(SHELL_LINE_MULTI);
    });

    it('every role stays under the cap at the maximum of everything, with many long repositories', () => {
      const many = Array.from({ length: 12 }, (_, i) => ({ key: `repo-${i}-${'k'.repeat(40)}`, full_name: `${'o'.repeat(99)}/${'r'.repeat(100)}`, base: 'b'.repeat(100) }));
      const ws = `/home/${'u'.repeat(60)}/.termhub/worktrees/${'p'.repeat(24)}/TER-12345`;
      for (const rs of [repos, many]) {
        const prompts = [
          implementerPrompt({ card, branch: 'b'.repeat(60), base: 'main', repos: rs, workspace: ws, naming, policy: 'p'.repeat(5000), custom, description: 'd'.repeat(5000), rules: big }),
          fixerPrompt({ ref: 'TER-1', branch: 'b'.repeat(60), base: 'main', reason: 'ci', detail: 'x'.repeat(5000), naming, custom, rules: big, repos: rs, repoKey: rs[1]!.key, workspace: ws }),
          fixerPrompt({ ref: 'TER-1', branch: 'b', base: 'main', reason: 'conflict', detail: 'y', custom, repos: rs, workspace: ws }),
          integratorPrompt({ epic: card, branch: 'b'.repeat(60), base: 'main', prUrl: 'https://x/pr/1', policy: 'p'.repeat(5000), custom, rules: big, repos: rs, workspace: ws }),
        ];
        for (const p of prompts) {
          expect(p.length + ORIGIN_REMINDER.length + 2).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
          // the parts that make the run work are never dropped
          expect(p).toMatch(/\/<key> push -u origin|cd <key> sozinho numa chamada e, na seguinte, git push -u origin/);
          expect(p).toContain(SHELL_LINE_MULTI);
          expect(p).toContain('report_card');
        }
      }
    });
  });
});
