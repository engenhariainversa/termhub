import { describe, expect, it } from 'vitest';
import { hintsOf, languageHints, transcribeUrl } from './whisper.js';

describe('languageHints (TER-1096)', () => {
  it('the client language first, then the account one, as whisper codes without repeats', () => {
    expect(languageHints('en-US,en;q=0.9', 'pt-BR')).toEqual(['en', 'pt']);
    expect(languageHints('es', 'es')).toEqual(['es']);
    expect(languageHints(undefined, 'en')).toEqual(['en']);
    expect(languageHints('fr', null)).toEqual([]);
  });
});

describe('hintsOf', () => {
  it('reads only well-formed codes off a row meta', () => {
    expect(hintsOf({ language_hints: ['en', 'pt'] })).toEqual(['en', 'pt']);
    expect(hintsOf({ language_hints: ['en&x=1', 3, 'es'] })).toEqual(['es']);
    expect(hintsOf({ language_hints: 'en' })).toEqual([]);
    expect(hintsOf(null)).toEqual([]);
  });
});

describe('transcribeUrl', () => {
  it('detects by default and forces only an operator-chosen language', () => {
    expect(transcribeUrl('http://w:8000', null, [])).toBe('http://w:8000/transcribe?language=auto');
    expect(transcribeUrl('http://w:8000', 'auto', ['en'])).toBe('http://w:8000/transcribe?language=auto&hints=en');
    expect(transcribeUrl('http://w:8000', 'pt', [])).toBe('http://w:8000/transcribe?language=pt');
  });
});
