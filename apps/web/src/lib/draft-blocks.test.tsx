// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatTurn } from '../components/chat/ChatTurn';
import type { ChatMessage } from './types';
import { decorateDraftBlocks, draftClipboard } from './draft-blocks';
import { renderMarkdown } from './markdown';

// TER-1159: the real Markdown path, end to end — a ```draft fence in an answer becomes a "Mensagem
// pronta" card whose "Copiar" puts HTML and plain text on the clipboard.

const DRAFT = ['Hi @Ana,', '', '1. Ship **v2** today', '   - check [the logs](https://logs.example/x)', '   - ping @Bob', '2. Close the card', '', '_Thanks!_'].join('\n');
const ANSWER = `Aqui está:\n\n\`\`\`draft\n${DRAFT}\n\`\`\`\n\nQuer que eu ajuste?`;

function answer(text: string): ChatMessage {
  return { id: 'm1', conversation_id: 'c1', role: 'assistant', text, error_code: null, created_at: '2026-10-30T00:00:00.000Z' };
}

/** jsdom's Blob has no `text()`. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

class FakeClipboardItem {
  constructor(public readonly items: Record<string, Blob>) {}
}

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  vi.unstubAllGlobals();
});

describe('decorateDraftBlocks', () => {
  it('turns a draft fence into a card with its Markdown rendered and its source kept for the copy', () => {
    const el = document.createElement('div');
    el.innerHTML = decorateDraftBlocks(renderMarkdown(ANSWER, { markdownOnly: true }));
    const card = el.querySelector('figure.draft-card');
    expect(card).not.toBeNull();
    expect(el.querySelector('pre')).toBeNull();
    expect(card?.querySelector('.draft-card__title')?.textContent).toBe('Mensagem pronta');
    expect(card?.getAttribute('data-draft-source')).toBe(DRAFT);
    expect(card?.querySelector('.draft-card__body ol > li > ul > li a')?.getAttribute('href')).toBe('https://logs.example/x');
    // The prose around the fence stays as it was.
    expect(el.textContent).toContain('Quer que eu ajuste?');
  });

  it('leaves any other fence alone, and is idempotent', () => {
    const html = renderMarkdown('```bash\nnpm test\n```', { markdownOnly: true });
    expect(decorateDraftBlocks(html)).toBe(html);
    const once = decorateDraftBlocks(renderMarkdown(ANSWER, { markdownOnly: true }));
    expect(decorateDraftBlocks(once)).toBe(once);
  });

  it('keeps model-written markup in the draft inert', () => {
    const el = document.createElement('div');
    el.innerHTML = decorateDraftBlocks(renderMarkdown('```draft\n<img src=x onerror=alert(1)> oi\n```', { markdownOnly: true }));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.draft-card__body')?.textContent).toContain('oi');
  });
});

describe('draftClipboard', () => {
  it('gives HTML with the nested list inside its numbered item, and Slack-flavoured plain text', () => {
    const { html, plain } = draftClipboard(DRAFT);
    const el = document.createElement('div');
    el.innerHTML = html;
    const items = el.querySelectorAll('ol > li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('strong')?.textContent).toBe('v2');
    expect(Array.from(items[0].querySelectorAll('ul > li')).map((li) => li.textContent)).toEqual(['check the logs', 'ping @Bob']);
    expect(el.querySelector('em')?.textContent).toBe('Thanks!');
    expect(plain).toBe(['Hi @Ana,', '', '1. Ship *v2* today', '   • check the logs (https://logs.example/x)', '   • ping @Bob', '2. Close the card', '', '_Thanks!_'].join('\n'));
  });
});

describe('the card in an answer', () => {
  it('shows "Mensagem pronta" with a Copiar that writes HTML and plain text, then says "Copiado"', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText: vi.fn() }, configurable: true });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const { getByRole, getByText } = render(
      <ol>
        <ChatTurn message={answer(ANSWER)} waiting={false} failed={false} />
      </ol>,
    );
    expect(getByText('Mensagem pronta')).not.toBeNull();

    const button = getByRole('button', { name: 'Copiar mensagem' });
    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toBe('Copiado ✓'));
    const item = write.mock.calls[0][0][0] as FakeClipboardItem;
    expect(await blobText(item.items['text/plain'])).toBe(draftClipboard(DRAFT).plain);
    expect(await blobText(item.items['text/html'])).toContain('<ol>');
  });

  it('falls back to plain text when the browser has no ClipboardItem', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { getByRole } = render(
      <ol>
        <ChatTurn message={answer(ANSWER)} waiting={false} failed={false} />
      </ol>,
    );
    fireEvent.click(getByRole('button', { name: 'Copiar mensagem' }));
    // jsdom has no `execCommand`, so the rich fallback says no and the plain one copies.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(draftClipboard(DRAFT).plain));
  });
});
