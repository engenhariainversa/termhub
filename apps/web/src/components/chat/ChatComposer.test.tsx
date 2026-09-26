// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

type Props = ComponentProps<typeof ChatComposer>;

/** The composer owns its text now: tests type into it and read the box, never a parent's state. */
function renderComposer(over: Partial<Props> = {}) {
  const onSend = over.onSend ?? vi.fn(async () => true);
  const view = render(<ChatComposer onSend={onSend} {...over} />);
  return { ...view, onSend, box: screen.getByPlaceholderText(/pergunte/i) as HTMLTextAreaElement };
}

/** A mouse, which is the pointer `enterSends()` sends on. */
function installFinePointer(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () => ({ matches: false }) as MediaQueryList;
}

function installCoarsePointer(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) => ({ matches: query.includes('coarse') }) as MediaQueryList;
}

afterEach(() => {
  cleanup();
  // enterSends() asks `matchMedia` on every keystroke; the pointer tests install one.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('ChatComposer', () => {
  it('asks for the message in the box itself', () => {
    renderComposer();

    expect(screen.getByPlaceholderText('Pergunte ou peça algo às suas máquinas')).toBeTruthy();
  });

  it('keeps the box at 16px, because a smaller field makes iOS zoom the page on focus', () => {
    // Safari on iOS zooms into any field whose font is under 16px the moment it takes focus, and a
    // zoomed page is wider than the screen — which is what "tapping the box blows out the side"
    // was. jsdom neither zooms nor lays out, so the class is what can be pinned here; the effect
    // itself only shows on a device.
    const { box } = renderComposer();
    expect(box.className).toContain('text-base');
    expect(box.className).not.toContain('text-sm');
    // And the box keeps its own drag: without this, panning inside it is handed to whatever can
    // scroll next, which on a phone was the document.
    expect(box.className).toContain('overscroll-contain');
  });

  it('keeps the text to itself: typing reaches nobody, sending hands the text over with no attachments', () => {
    const { box, onSend } = renderComposer();

    fireEvent.change(box, { target: { value: 'oi' } });
    expect(box.value).toBe('oi');
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('oi', []);
  });

  it('sends on Enter with a fine pointer, and writes a newline with Shift', () => {
    installFinePointer();
    const { box, onSend } = renderComposer();

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.change(box, { target: { value: 'mais' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends on ⌘+Enter, the shortcut people bring from every other message box', async () => {
    // Coarse pointer on purpose: plain Enter is a newline here, and ⌘+Enter still has to send.
    installCoarsePointer();
    const { box, onSend } = renderComposer();

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    // The composer sends one message at a time: the first send has to settle before the second
    // keystroke can be accepted.
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    fireEvent.change(box, { target: { value: 'de novo' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it('does not send on ⌘+Enter with an empty box', () => {
    const { box, onSend } = renderComposer();
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send on Enter with a coarse pointer, where Enter is how a line gets started', () => {
    installCoarsePointer();
    const { box, onSend } = renderComposer();

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('refuses to send while the host cannot run it, says why, and still lets the message be typed', () => {
    const { box, onSend } = renderComposer({ blockedReason: 'a máquina do chat está offline' });
    fireEvent.change(box, { target: { value: 'o que está rodando?' } });
    const button = screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;

    // The reason is on screen, next to the button that is refusing — a box that goes grey in silence is
    // the one thing this screen must never do.
    expect(screen.getByText('a máquina do chat está offline')).toBeTruthy();
    expect(button.disabled).toBe(true);
    // …and the box itself stays usable: a message can be written while the machine is being woken up.
    expect(box.readOnly).toBe(false);
    expect(box.disabled).toBe(false);
    expect(box.value).toBe('o que está rodando?');

    // Neither the button nor the keyboard can get past it.
    fireEvent.click(button);
    installFinePointer();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('empties the box the moment it sends, and gives the text back only when the send is refused', async () => {
    let resolveSend!: (ok: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (resolveSend = resolve)));
    const { box } = renderComposer({ onSend });

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    // Cleared before the answer comes: a POST resolves only when the whole answer is written, and a box
    // that keeps the sent text that long reads as a chat that swallowed the message.
    expect(box.value).toBe('');

    resolveSend(false);
    await waitFor(() => expect(box.value).toBe('oi'));

    // Accepted: it stays empty.
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    expect(box.value).toBe('');
    resolveSend(true);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(box.value).toBe('');
  });

  it('does not overwrite what was typed meanwhile when a send is refused', async () => {
    let resolveSend!: (ok: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((resolve) => (resolveSend = resolve)));
    const { box } = renderComposer({ onSend });

    fireEvent.change(box, { target: { value: 'primeira' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    fireEvent.change(box, { target: { value: 'segunda' } });
    resolveSend(false);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(box.value).toBe('segunda');
  });

  it('shows the status it is given in the fixed line, in the danger colour', () => {
    renderComposer({ status: 'Não foi possível enviar a mensagem' });
    const line = screen.getByText('Não foi possível enviar a mensagem');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toContain('text-danger');
    // Fixed height, always mounted: text appearing here moves nothing above it.
    expect(line.className).toContain('h-4');
  });

  it('the status line is there, empty and the same height, when there is nothing to say', () => {
    renderComposer();
    const regions = screen.getAllByRole('status');
    expect(regions[0].textContent).toBe('');
    expect(regions[0].className).toContain('h-4');
  });

  it('sizes the box from its scroll height, floored at one line, without touching rows', () => {
    const { box } = renderComposer();

    // jsdom lays nothing out: `scrollHeight` is 0 and no line height is computed, so the floor (one
    // line at the fallback line height) is what the box ends up with. Tailwind's `py-1` is never
    // applied here, but jsdom's own default stylesheet still gives a textarea 2px of padding a side —
    // zeroed inline, so the number below is the fallback line height and nothing else.
    box.style.padding = '0';
    fireEvent.change(box, { target: { value: 'linha' } });

    expect(box.style.height).toBe('24px');
    expect(box.rows).toBe(1);
  });

  it('measures at height auto and restores the box\'s own scroll position afterwards', () => {
    const { box } = renderComposer();

    // Collapsing the box to measure it also collapses how far it can be scrolled, and a browser clamps
    // `scrollTop` while it is collapsed: the effect has to read it before and write it back after.
    const writes: string[] = [];
    let scrollTop = 120;
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        writes.push(`scrollTop=${v}`);
        scrollTop = v;
      },
    });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => 999 });
    // jsdom's default stylesheet pads a textarea by 2px a side (see the test above): zeroed, so the
    // cap is eight fallback lines exactly.
    box.style.padding = '0';

    fireEvent.change(box, { target: { value: 'linha\n'.repeat(12) } });

    // Capped at eight lines of the fallback line height, never the full 999px.
    expect(box.style.height).toBe('192px');
    expect(writes[writes.length - 1]).toBe('scrollTop=120');
    expect(box.scrollTop).toBe(120);
  });
});
