import { describe, expect, it } from 'vitest';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { SuggestionItem } from '../chat/decision-text.js';
import { ANSWER_CAP, PERMISSION_NEEDED, QUESTION_EXPIRED, QUESTION_UNANSWERED } from './escalation-text.js';
import { answerWhy, countdownPrecedent, escalationWhy, permissionWhy, roundScore, whyText, WHY_TEXT } from './why.js';

const auto = (over: Partial<AutoAnswer> = {}): AutoAnswer => ({ answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'r', sources: [{ kind: 'decision', id: 'd1' }], due_at: '', status: 'scheduled', ...over });
const item = (over: Partial<SuggestionItem> = {}): SuggestionItem => ({ question_index: 0, decision_id: 'd1', similarity: 0.99, selected: [0], source: { question: 'q', project_name: null, answered_at: '' }, ...over });
const card = (over: Partial<Pick<TabQuestion, 'kind' | 'auto_answer' | 'suggestion'>> = {}) => ({ kind: 'choice' as const, auto_answer: null, suggestion: null, ...over });

describe('answerWhy (TER-1011)', () => {
  it('a memory repeat names the decision and the lowest similarity of the suggestion', () => {
    const q = card({ auto_answer: auto(), suggestion: { items: [item({ similarity: 0.991 }), item({ question_index: 1, similarity: 0.984 })] } });
    expect(answerWhy(q, 'repeat')).toEqual({ why: 'precedent', rule_ref: 'decision:d1', score: 0.98 });
  });

  it("the concierge's countdown carries its own score", () => {
    expect(answerWhy(card({ auto_answer: auto({ by: 'concierge', score: 0.912 }) }), 'concierge')).toEqual({ why: 'precedent', rule_ref: 'decision:d1', score: 0.91 });
  });

  it('the recommended option has no precedent, also when its countdown was already running', () => {
    expect(answerWhy(card(), 'recommended')).toEqual({ why: 'recommended' });
    expect(answerWhy(card({ auto_answer: auto({ by: 'automation', sources: [] }) }), 'repeat')).toEqual({ why: 'recommended' });
  });

  it('a countdown with no source has no ref', () => {
    expect(countdownPrecedent(card({ auto_answer: auto({ sources: [] }) }))).toEqual({ ref: null, score: null });
    expect(countdownPrecedent(card({ auto_answer: auto({ sources: [{ kind: 'note', id: 'n1' }] }) }))).toEqual({ ref: 'note:n1', score: null });
  });
});

describe('permissionWhy (TER-1011)', () => {
  it('names the allow rule, or the termhub tool', () => {
    expect(permissionWhy('Bash(npm test:*)', false)).toEqual({ why: 'allow_rule', rule_ref: 'Bash(npm test:*)' });
    expect(permissionWhy('mcp__termhub__create_task', true)).toEqual({ why: 'termhub_tool', rule_ref: 'mcp__termhub__create_task' });
  });
});

describe('escalationWhy (TER-1011)', () => {
  it('no decision in the memory', () => {
    expect(escalationWhy(QUESTION_UNANSWERED, card())).toEqual({ why: 'no_precedent' });
    expect(escalationWhy(QUESTION_UNANSWERED, undefined)).toEqual({ why: 'no_precedent' });
    // a suggestion the concierge wrote cites no decision of the person's
    expect(escalationWhy(QUESTION_EXPIRED, card({ suggestion: { items: [item({ decision_id: '' })] } }))).toEqual({ why: 'no_precedent' });
  });

  it('the closest decision, with its score, when it was not close enough', () => {
    const q = card({ suggestion: { items: [item({ decision_id: 'd2', similarity: 0.81 }), item({ decision_id: 'd3', similarity: 0.934 })] } });
    expect(escalationWhy(QUESTION_UNANSWERED, q)).toEqual({ why: 'weak_precedent', rule_ref: 'decision:d3', score: 0.93 });
  });

  it('a countdown that did not go out names its precedent', () => {
    expect(escalationWhy(QUESTION_EXPIRED, card({ auto_answer: auto({ status: 'cancelled' }), suggestion: { items: [item({ similarity: 0.99 })] } }))).toEqual({
      why: 'auto_answer_stopped',
      rule_ref: 'decision:d1',
      score: 0.99,
    });
  });

  it('a permission outside the rules; nothing for the other reasons', () => {
    expect(escalationWhy(PERMISSION_NEEDED, undefined)).toEqual({ why: 'outside_rules' });
    expect(escalationWhy(ANSWER_CAP, card())).toEqual({});
  });
});

describe('whyText', () => {
  it('translates each code, null for none or an unknown one', () => {
    expect(whyText('precedent', 'pt-BR')).toBe(WHY_TEXT.precedent);
    expect(whyText('precedent', 'en')).toBe('answered with a decision you took before');
    expect(whyText(null, 'en')).toBeNull();
    expect(whyText('from_the_future', 'en')).toBeNull();
  });

  it('roundScore keeps two decimals', () => {
    expect(roundScore(0.98765)).toBe(0.99);
    expect(roundScore(Number.NaN)).toBeNull();
    expect(roundScore(undefined)).toBeNull();
  });
});
