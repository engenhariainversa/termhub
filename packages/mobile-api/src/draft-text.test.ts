import { describe, expect, it } from 'vitest';
import { draftPlainText, isDraftFence } from './draft-text.js';

describe('isDraftFence', () => {
  it('takes the first word of the info string, in any case', () => {
    expect(isDraftFence('draft')).toBe(true);
    expect(isDraftFence(' Draft slack')).toBe(true);
    expect(isDraftFence('drafts')).toBe(false);
    expect(isDraftFence('bash')).toBe(false);
    expect(isDraftFence('')).toBe(false);
    expect(isDraftFence(null)).toBe(false);
  });
});

describe('draftPlainText', () => {
  it('writes bold, italic and strike the way Slack reads them typed', () => {
    expect(draftPlainText('**Deploy** hoje, *talvez* às 18h, ~~amanhã~~')).toBe('*Deploy* hoje, _talvez_ às 18h, ~amanhã~');
    expect(draftPlainText('__forte__ e _leve_')).toBe('*forte* e _leve_');
  });

  it('turns bullets into "•", keeps nesting and numbered lists', () => {
    const md = ['Hi @Ana,', '', '1. Ship **v2**', '   - check the logs', '   * ping @Bob', '2. Close the card', '- last'].join('\n');
    expect(draftPlainText(md)).toBe(['Hi @Ana,', '', '1. Ship *v2*', '   • check the logs', '   • ping @Bob', '2. Close the card', '• last'].join('\n'));
  });

  it('writes a link as its text and address, or the address alone', () => {
    expect(draftPlainText('See [the PR](https://github.com/x/y/pull/1) and [https://a.b](https://a.b)')).toBe('See the PR (https://github.com/x/y/pull/1) and https://a.b');
  });

  it('makes a heading a bold line and drops rules', () => {
    expect(draftPlainText('## Status\n\n---\n\nok')).toBe('*Status*\n\nok');
    expect(draftPlainText('# **Já negrito**')).toBe('*Já negrito*');
  });

  it('leaves code untouched', () => {
    expect(draftPlainText('run `npm **ci**` now')).toBe('run `npm **ci**` now');
    expect(draftPlainText('```\n- a **b**\n```')).toBe('```\n- a **b**\n```');
  });

  it('does not take a multiplication or a lone star for emphasis', () => {
    expect(draftPlainText('2 * 3 * 4')).toBe('2 * 3 * 4');
  });
});
