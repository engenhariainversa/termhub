// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { firstLink, messageCopyText } from './chat-plain-text';
import type { ChatMessage } from './types';

const plain = (text: string) => messageCopyText({ role: 'assistant', text });

describe('messageCopyText (TER-1090)', () => {
  it('drops the emphasis and heading marks, one blank line between paragraphs', () => {
    expect(plain('# Título\n\nUm **negrito** e _itálico_ com `código`.\n\nOutro parágrafo.')).toBe('Título\n\nUm negrito e itálico com código.\n\nOutro parágrafo.');
  });

  it('keeps a link with its address, and a bare address once', () => {
    expect(plain('Veja [o termhub](https://termhub.dev) ou <https://app.termhub.dev>.')).toBe('Veja o termhub (https://termhub.dev) ou https://app.termhub.dev.');
  });

  it('writes bullets and numbered items, a nested list indented', () => {
    expect(plain('- um\n- dois\n  - dois e meio\n\n3. três\n4. quatro')).toBe('• um\n• dois\n  • dois e meio\n\n3. três\n4. quatro');
  });

  it('keeps a code block as written, without its fence', () => {
    expect(plain('Rode:\n\n```bash\nnpm test\nnpm run build\n```\n\nPronto.')).toBe('Rode:\n\nnpm test\nnpm run build\n\nPronto.');
  });

  it('writes a table a row per line, its cells apart by a tab', () => {
    expect(plain('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a\tb\n1\t2');
  });

  it('keeps a line break inside a paragraph', () => {
    expect(plain('linha um\nlinha dois')).toBe('linha um\nlinha dois');
  });

  it("copies the person's words as typed, and an audio transcript", () => {
    const audio = { id: 'a', name: 'nota.m4a', mime: 'audio/mp4', kind: 'audio', bytes: 1, status: 'ready', error_code: null, meta: null, created_at: '', transcript: 'oi, tudo bem?' } as NonNullable<ChatMessage['attachments']>[number];
    expect(messageCopyText({ role: 'user', text: ' **oi** ', attachments: [audio] })).toBe('**oi**\n\noi, tudo bem?');
  });
});

describe('firstLink', () => {
  it('finds the first address, without the punctuation around it', () => {
    expect(firstLink('Veja o termhub (https://termhub.dev). E https://x.dev')).toBe('https://termhub.dev');
    expect(firstLink('sem link')).toBeNull();
  });
});
