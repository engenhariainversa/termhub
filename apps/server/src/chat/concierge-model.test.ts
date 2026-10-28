import { describe, expect, it } from 'vitest';
import { conciergeModel, modelFamily } from './concierge-model.js';

describe('modelFamily', () => {
  it('reads the family of an alias, a context suffix and a full id', () => {
    expect(modelFamily('fable')).toBe('fable');
    expect(modelFamily('fable[1m]')).toBe('fable');
    expect(modelFamily('claude-fable-5-1')).toBe('fable');
    expect(modelFamily('claude-opus-5-5')).toBe('opus');
    expect(modelFamily('Sonnet')).toBe('sonnet');
  });

  it('names no family for anything else', () => {
    expect(modelFamily('opusplan')).toBeNull();
    expect(modelFamily('gpt-5-codex')).toBeNull();
  });
});

describe('conciergeModel', () => {
  it('keeps today\'s behaviour with nothing blocked', () => {
    expect(conciergeModel('fable', [])).toEqual({ model: 'fable', steered: false });
    expect(conciergeModel(null, [])).toEqual({ model: null, steered: false });
  });

  it('moves a project default on Fable to the next allowed family', () => {
    expect(conciergeModel('fable', ['fable'])).toEqual({ model: 'opus', steered: true });
    expect(conciergeModel('claude-fable-5-1', ['fable'])).toEqual({ model: 'opus', steered: true });
    expect(conciergeModel('fable[1m]', ['fable', 'opus'])).toEqual({ model: 'sonnet', steered: true });
  });

  it('names a model when there is none, since the CLI default may be the blocked one', () => {
    expect(conciergeModel(null, ['fable'])).toEqual({ model: 'opus', steered: true });
  });

  it('keeps an allowed model or one of no known family', () => {
    expect(conciergeModel('sonnet', ['fable'])).toEqual({ model: 'sonnet', steered: false });
    expect(conciergeModel('opusplan', ['fable'])).toEqual({ model: 'opusplan', steered: false });
  });

  it('keeps the model when every family is blocked', () => {
    expect(conciergeModel('fable', ['fable', 'opus', 'sonnet', 'haiku'])).toEqual({ model: 'fable', steered: false });
  });
});
