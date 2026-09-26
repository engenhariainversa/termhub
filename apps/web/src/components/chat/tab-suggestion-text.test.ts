import { describe, expect, it } from 'vitest';
import type { TabSuggestion } from '../../lib/types';
import { CONTEXT_PREVIEW_MAX, lastParagraph, suggestionTitle } from './tab-suggestion-text';

const s = (over: Partial<TabSuggestion> = {}): TabSuggestion => ({ id: 's1', tab_id: 't1', tab_name: 'api', kind: 'suggestion', payload: { text: 'commit it' }, status: 'open', answer: null, error_code: null, created_at: '', answered_at: null, closed_at: null, ...over });

describe('lastParagraph (spec 2026-09-26 §6.4)', () => {
  it('is the text after the last blank line', () => {
    expect(lastParagraph('Criei o arquivo.\n\nRodei os testes.\n  \nQuer que eu faça o commit?', 400)).toBe('Quer que eu faça o commit?');
  });
  it('is the whole text when it has one paragraph', () => {
    expect(lastParagraph('  Quer seguir?\nOu paro aqui?  ', 400)).toBe('Quer seguir?\nOu paro aqui?');
  });
  it('keeps the end of a long paragraph, marked with …, within max', () => {
    const out = lastParagraph(`${'a'.repeat(500)} fim?`, 400);
    expect(out).toHaveLength(400);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith(' fim?')).toBe(true);
  });
  it('never starts on half a surrogate pair', () => {
    expect(/^…(?:😀)+$/u.test(lastParagraph('😀'.repeat(300), 400))).toBe(true);
  });
  it('previews 400 characters', () => {
    expect(CONTEXT_PREVIEW_MAX).toBe(400);
  });
});

describe('suggestionTitle', () => {
  it('asks for an answer while open, and says what the tab suggested once closed', () => {
    expect(suggestionTitle(s())).toBe('«api» está esperando sua resposta');
    expect(suggestionTitle(s({ tab_name: null }))).toBe('Uma aba está esperando sua resposta');
    expect(suggestionTitle(s({ status: 'answered' }))).toBe('«api» sugere:');
    expect(suggestionTitle(s({ status: 'dismissed', tab_name: null }))).toBe('Uma aba sugere:');
  });
});
