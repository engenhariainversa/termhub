import { AI_MEMORY_RULE_PATH_RE } from '@termhub/machine-ops';
import { describe, expect, it } from 'vitest';
import { AI_MEMORY_DECISION_MAX, AI_MEMORY_RULES_MAX, AI_MEMORY_TITLE_MAX, pageHash, planSync, rulePage, rulePages, ruleSlug } from './ai-memory-rules.js';
import type { CurrentRule } from './current-rules.js';

const rule = (id: string, title = 'Usar pnpm', decision = 'Sempre pnpm, nunca npm.', project_id: string | null = 'p1'): CurrentRule => ({
  ref: `note:${id}`,
  title,
  decision,
  project_id,
});

describe('ruleSlug', () => {
  it('lowercases, strips accents and turns everything else into dashes', () => {
    expect(ruleSlug('Não fazer deploy na Sexta!')).toBe('nao-fazer-deploy-na-sexta');
    expect(ruleSlug('  --Ação/Reação--  ')).toBe('acao-reacao');
  });
  it('caps at 40 chars without a trailing dash, and falls back to "regra"', () => {
    const s = ruleSlug('a'.repeat(39) + ' bbbbbb');
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
    expect(ruleSlug('日本語')).toBe('regra');
    expect(ruleSlug('')).toBe('regra');
  });
});

describe('rulePage', () => {
  it('builds the path, title, body and hash', () => {
    const p = rulePage(rule('abc123'))!;
    expect(p.path).toBe('_rules/termhub-usar-pnpm-abc123.md');
    expect(AI_MEMORY_RULE_PATH_RE.test(p.path)).toBe(true);
    expect(p.title).toBe('Usar pnpm');
    expect(p.body).toBe('Sempre pnpm, nunca npm.\n\nRegra vigente do termhub (note:abc123). Para mudar, use o termhub, não edite esta página.');
    expect(p.hash).toBe(pageHash(p.title, p.body));
  });
  it('says when a rule holds for every project', () => {
    expect(rulePage(rule('a1', 'T', 'D', null))!.body).toContain('Vale para todos os projetos.');
  });
  it('clips the title and the decision and keeps them on one line', () => {
    const p = rulePage(rule('a1', 'x'.repeat(200) + '\nsegunda linha', 'y'.repeat(1000)))!;
    expect(p.title.length).toBeLessThanOrEqual(AI_MEMORY_TITLE_MAX);
    expect(p.title).not.toContain('\n');
    expect(p.body.split('\n\n')[0]!.length).toBeLessThanOrEqual(AI_MEMORY_DECISION_MAX);
  });
  it('changes the hash when the decision changes', () => {
    expect(rulePage(rule('a1', 'T', 'D1'))!.hash).not.toBe(rulePage(rule('a1', 'T', 'D2'))!.hash);
  });
  it('refuses an id that cannot be part of a path', () => {
    expect(rulePage(rule('../x'))).toBeNull();
  });
});

describe('rulePages', () => {
  it('keeps the newest AI_MEMORY_RULES_MAX', () => {
    const pages = rulePages(Array.from({ length: 12 }, (_, i) => rule(`n${i}`, `Regra ${i}`)));
    expect(pages).toHaveLength(AI_MEMORY_RULES_MAX);
    expect(pages[0]!.path).toBe('_rules/termhub-regra-0-n0.md');
  });
});

describe('planSync', () => {
  const [a, b] = rulePages([rule('a1', 'A'), rule('b1', 'B')]);
  it('writes new and changed pages, skips unchanged ones, deletes the rest', () => {
    const plan = planSync([a!, b!], [
      { path: a!.path, hash: a!.hash },
      { path: b!.path, hash: 'old' },
      { path: '_rules/termhub-gone-z1.md', hash: 'h' },
    ]);
    expect(plan.writes.map((w) => w.path)).toEqual([b!.path]);
    expect(plan.deletes).toEqual(['_rules/termhub-gone-z1.md']);
  });
  it('nothing wanted deletes everything published', () => {
    expect(planSync([], [{ path: a!.path, hash: a!.hash }])).toEqual({ writes: [], deletes: [a!.path] });
  });
  it('nothing to do', () => {
    expect(planSync([a!], [{ path: a!.path, hash: a!.hash }])).toEqual({ writes: [], deletes: [] });
  });
});
