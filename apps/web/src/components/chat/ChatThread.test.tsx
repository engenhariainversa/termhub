// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatThread } from './ChatThread';

/** jsdom lays nothing out: the scroll container's geometry is faked through getters on the element. */
interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function fakeGeometry(el: HTMLElement, geo: Geometry): Geometry {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geo.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geo.scrollTop,
    set: (v: number) => {
      geo.scrollTop = v;
    },
  });
  return geo;
}

function Thread({ followKey, rows, reconnecting = false }: { followKey: number; rows: string[]; reconnecting?: boolean }) {
  return (
    <ChatThread reconnecting={reconnecting} followKey={followKey}>
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ChatThread>
  );
}

/** The scroll container is the list's parent; the list itself keeps the `Conversa` name. */
const scroller = () => screen.getByRole('list', { name: 'Conversa' }).parentElement as HTMLElement;

/** Lets a programmatic pin settle (its flag is cleared on the next frame). */
const nextFrame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));

class FakeResizeObserver {
  static callbacks: ResizeObserverCallback[] = [];
  constructor(cb: ResizeObserverCallback) {
    FakeResizeObserver.callbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeResizeObserver.callbacks = [];
});

describe('ChatThread', () => {
  it('stays pinned as rows arrive while the reader is at the bottom, and stops following once they scroll up', async () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });

    // New content, reader at the bottom: pinned to the new bottom before paint.
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: '↓ novas mensagens' })).toBeNull();
    await nextFrame();

    // The reader scrolls up to read back through history.
    geo.scrollTop = 100;
    fireEvent.scroll(el);

    // A streamed line arrives: the thread must not move, and the pill says there is something new.
    geo.scrollHeight = 1200;
    rerender(<Thread followKey={3} rows={['a', 'b', 'c']} />);
    expect(geo.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('the pill scrolls smoothly to the bottom and the thread follows again', async () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    await nextFrame();
    geo.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(<Thread followKey={3} rows={['a', 'b', 'c']} />);

    const scrollTo = vi.fn();
    (el as HTMLElement & { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
    fireEvent.click(screen.getByRole('button', { name: '↓ novas mensagens' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: '↓ novas mensagens' })).toBeNull();

    // The smooth scroll lands (the browser fires scroll events along the way; the last one is at the bottom).
    geo.scrollTop = 1000;
    fireEvent.scroll(el);
    // …and from here on the thread follows again.
    geo.scrollHeight = 1300;
    rerender(<Thread followKey={4} rows={['a', 'b', 'c', 'd']} />);
    expect(geo.scrollTop).toBe(1300);
  });

  it('re-pins when a row grows (a card, a thumbnail) through a ResizeObserver, but only while stuck', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    expect(FakeResizeObserver.callbacks.length).toBeGreaterThan(0);

    geo.scrollHeight = 1400;
    act(() => FakeResizeObserver.callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(geo.scrollTop).toBe(1400);
    await nextFrame();

    geo.scrollTop = 200;
    fireEvent.scroll(el);
    geo.scrollHeight = 1800;
    act(() => FakeResizeObserver.callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(geo.scrollTop).toBe(200);
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(200);
  });

  it('"Reconectando…" is an overlay badge: the list node is untouched when it appears', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const list = screen.getByRole('list', { name: 'Conversa' });
    rerender(<Thread followKey={1} rows={['a']} reconnecting />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveTextContent('Reconectando…');
    expect(badge.className).toContain('absolute');
    expect(screen.getByRole('list', { name: 'Conversa' })).toBe(list);
  });

  it('renders the empty state it is given above the list', () => {
    render(
      <ChatThread reconnecting={false} followKey={1} empty={<p>Peça algo</p>}>
        {null}
      </ChatThread>,
    );
    expect(screen.getByText('Peça algo')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Conversa' })).toBeEmptyDOMElement();
  });
});
