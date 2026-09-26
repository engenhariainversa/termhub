// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTurn } from './ChatTurn';
import type { ChatMessage } from '../../lib/types';

// Counted, not stubbed away for convenience: what this file pins is how often the answer is parsed
// and sanitised, which is invisible through the rendered output.
const renderMarkdown = vi.hoisted(() => vi.fn((text: string) => `<p>${text}</p>`));
vi.mock('../../lib/markdown', () => ({ renderMarkdown }));

// Spied, not replaced: the code-block tests below need the real decoration. What the spy is for is
// counting the calls, since an answer with no fence must not be parsed a second time at all.
const decorateCodeBlocks = vi.hoisted(() => vi.fn());
vi.mock('../../lib/code-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/code-blocks')>();
  return { ...actual, decorateCodeBlocks: decorateCodeBlocks.mockImplementation(actual.decorateCodeBlocks) };
});

function answer(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'feito', error_code: null, created_at: '2026-09-21T00:00:00.000Z', ...overrides };
}

beforeEach(() => {
  renderMarkdown.mockClear();
  decorateCodeBlocks.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ChatTurn', () => {
  it('renders the answer through the markdown-only path, not the notes one', () => {
    render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).toHaveBeenCalledWith('feito', { markdownOnly: true });
  });

  it('does not re-parse the answer when the thread re-renders with the same props', () => {
    const message = answer();
    // A fresh element every time, deliberately: passing the very same element object back would
    // make React bail out on element identity alone and prove nothing about this component.
    const turn = () => (
      <ol>
        <ChatTurn message={message} waiting={false} failed={false} />
      </ol>
    );
    const { rerender } = render(turn());
    rerender(turn());
    rerender(turn());

    // A streamed answer re-renders the whole thread on every delta; parsing every row again each
    // time cost about 1 ms per message.
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });

  it('does not run its own body again for unchanged props', () => {
    // `memo` is what stops the re-render entirely, and the parse count alone cannot see that (the
    // inner `useMemo` would hide it), so the render body is observed directly: `role` is read on
    // every pass through it.
    let reads = 0;
    const base = answer();
    const message = {
      ...base,
      get role() {
        reads += 1;
        return base.role;
      },
    } as ChatMessage;
    // Fresh elements with equal prop values: `memo`'s own shallow comparison is what must stop the
    // second pass, not React's element-identity bailout.
    const turn = () => (
      <ol>
        <ChatTurn message={message} waiting={false} failed={false} />
      </ol>
    );
    const { rerender } = render(turn());
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);

    rerender(turn());

    expect(reads).toBe(afterFirst);
  });

  it('does not re-parse an unchanged answer when only its tool list is a fresh array', () => {
    // `ChatPage` rebuilds `live.actions` on every event, so a row that saw a tool call gets a new
    // array identity on every delta and `memo` cannot bail out: the parse must still be cached.
    const message = answer();
    const { rerender } = render(
      <ol>
        <ChatTurn message={message} tools={[{ tool: 'Bash' }]} waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} tools={[{ tool: 'Bash' }]} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });

  it('parses again when the streamed body actually grows', () => {
    const message = answer({ text: '' });
    const { rerender } = render(
      <ol>
        <ChatTurn message={message} streaming="par" waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} streaming="parcial" waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown.mock.calls.map((c) => c[0])).toEqual(['par', 'parcial']);
  });

  it('re-parses only the tail of a streaming answer: the settled paragraphs are parsed once', () => {
    const message = answer({ text: '' });
    const { rerender } = render(
      <ol>
        <ChatTurn message={message} streaming={'primeiro\n\nseg'} waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} streaming={'primeiro\n\nsegundo'} waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} streaming={'primeiro\n\nsegundo\n\nterc'} waiting={false} failed={false} />
      </ol>,
    );

    // The first paragraph is parsed once, when it settles; every delta after that parses the tail only.
    expect(renderMarkdown.mock.calls.map((c) => c[0])).toEqual(['primeiro\n\n', 'seg', 'segundo', 'primeiro\n\nsegundo\n\n', 'terc']);
  });

  it('renders the whole body once when the answer settles', () => {
    const { rerender } = render(
      <ol>
        <ChatTurn message={answer({ text: '' })} streaming={'primeiro\n\nsegundo'} waiting={false} failed={false} />
      </ol>,
    );
    renderMarkdown.mockClear();
    rerender(
      <ol>
        <ChatTurn message={answer({ text: 'primeiro\n\nsegundo' })} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown.mock.calls.map((c) => c[0])).toEqual(['primeiro\n\nsegundo']);
  });

  it('mounts every row with the enter motion class and reserves a line under "pensando…"', () => {
    const { container, rerender } = render(
      <ol>
        <ChatTurn message={answer({ text: '' })} waiting failed={false} />
      </ol>,
    );
    expect(container.querySelector('li')?.classList.contains('chat-enter')).toBe(true);
    // The placeholder's container keeps a minimum height, so the first delta does not change the row's height.
    expect(container.querySelector('.prose-termhub')?.classList.contains('min-h-10')).toBe(true);

    rerender(
      <ol>
        <ChatTurn message={answer({ role: 'user', text: 'oi' })} waiting={false} failed={false} />
      </ol>,
    );
    expect(container.querySelector('li')?.classList.contains('chat-enter')).toBe(true);
  });

  it('keeps a wide or unbreakable answer from scrolling the whole thread sideways', () => {
    const { container } = render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    // jsdom lays nothing out, so only the classes can be asserted: `break-words` for a long path,
    // `overflow-x-auto` for a wide GFM table, whose min-content width no amount of wrapping shrinks.
    const prose = container.querySelector('.prose-termhub');
    expect(prose?.classList.contains('break-words')).toBe(true);
    expect(prose?.classList.contains('overflow-x-auto')).toBe(true);
  });

  it('does not decorate an answer with no fence in it at all', () => {
    render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    // The rendered body is `<p>feito</p>`: there is no `<pre>` for the decoration to find, so it is
    // not run. It would return the same HTML — this is about not paying for a DOMParser round trip on
    // every delta of every prose-only answer.
    expect(decorateCodeBlocks).not.toHaveBeenCalled();
  });

  it('does decorate an answer that has a fence', () => {
    renderMarkdown.mockReturnValueOnce('<pre><code class="language-bash">npm test</code></pre>');
    render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    expect(decorateCodeBlocks).toHaveBeenCalledTimes(1);
  });

  it('renders a user message\'s attachments under its text, and a message with attachments only', () => {
    const attachment = { id: 'a1', name: 'relatorio.pdf', mime: 'application/pdf', kind: 'pdf' as const, bytes: 10, status: 'ready' as const, error_code: null, meta: null, created_at: '' };
    const { rerender } = render(
      <ol>
        <ChatTurn message={answer({ role: 'user', text: 'leia', attachments: [attachment] })} waiting={false} failed={false} />
      </ol>,
    );
    expect(screen.getByText('leia')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Anexos da mensagem' })).toBeTruthy();

    rerender(
      <ol>
        <ChatTurn message={answer({ role: 'user', text: '', attachments: [attachment] })} waiting={false} failed={false} />
      </ol>,
    );
    expect(screen.getByRole('link', { name: /relatorio\.pdf/ })).toBeTruthy();
    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  it('never parses the user\'s own words as Markdown', () => {
    render(
      <ol>
        <ChatTurn message={answer({ role: 'user', text: '**oi**' })} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).not.toHaveBeenCalled();
  });

  describe('code blocks', () => {
    afterEach(() => {
      // jsdom has no clipboard by default; each test that added one must not leak it to the next.
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    });

    it('shows the language header and a copy button whose accessible name says copying', () => {
      renderMarkdown.mockReturnValueOnce('<pre><code class="language-bash">npm test\n</code></pre>');
      const { getByRole, getByText } = render(
        <ol>
          <ChatTurn message={answer()} waiting={false} failed={false} />
        </ol>,
      );

      expect(getByText('bash')).not.toBeNull();
      expect(getByRole('button', { name: /copiar/i })).not.toBeNull();
    });

    /** Renders one answer whose body is a single fence, and hands back its copy button. */
    function renderFence(): { button: HTMLElement; live: () => string | null } {
      renderMarkdown.mockReturnValueOnce('<pre><code class="language-bash">npm test</code></pre>');
      const { getByRole, container } = render(
        <ol>
          <ChatTurn message={answer()} waiting={false} failed={false} />
        </ol>,
      );
      return {
        button: getByRole('button', { name: /copiar/i }),
        live: () => container.querySelector('[data-copy-live]')?.textContent ?? null,
      };
    }

    it('clicking copy calls navigator.clipboard.writeText with exactly the code\'s text', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      // A trailing newline is how a fenced block's `<code>` renders (see markdown.test.ts) — it must
      // not land on the clipboard, and neither must the header's own text.
      renderMarkdown.mockReturnValueOnce('<pre><code class="language-bash">npm test &amp;&amp; echo &lt;ok&gt;\n</code></pre>');
      const { getByRole } = render(
        <ol>
          <ChatTurn message={answer()} waiting={false} failed={false} />
        </ol>,
      );

      fireEvent.click(getByRole('button', { name: /copiar/i }));

      expect(writeText).toHaveBeenCalledWith('npm test && echo <ok>');
    });

    it('says "copiado" on the button and writes it into the live region the block was built with', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
      const { button, live } = renderFence();
      // The region is part of the figure from the start — that is the half a screen reader needs; that
      // it is spoken is a browser behaviour no jsdom test can observe.
      expect(live()).toBe('');

      fireEvent.click(button);

      await waitFor(() => expect(button.textContent).toBe('copiado'));
      expect(live()).toBe('Código copiado');
    });

    it('says "falhou" when there is no navigator.clipboard at all, instead of a tap that does nothing', () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      const { button, live } = renderFence();

      expect(() => fireEvent.click(button)).not.toThrow();

      expect(button.textContent).toBe('falhou');
      expect(button.textContent?.toLowerCase()).not.toContain('copiado');
      expect(live()).toBe('Não foi possível copiar o código');
    });

    it('says "falhou" when writeText rejects, which is Firefox without the permission or an unfocused document', async () => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('not allowed')) }, configurable: true });
      const { button, live } = renderFence();

      fireEvent.click(button);

      await waitFor(() => expect(button.textContent).toBe('falhou'));
      expect(live()).toBe('Não foi possível copiar o código');
    });

    it('does not throw when writeText returns something that is not a promise', () => {
      // The old code called `.then` on whatever came back: an implementation that returns undefined
      // threw straight out of the click handler, which reads as the same dead tap.
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => undefined) }, configurable: true });
      const { button } = renderFence();

      expect(() => fireEvent.click(button)).not.toThrow();
    });
  });
});
