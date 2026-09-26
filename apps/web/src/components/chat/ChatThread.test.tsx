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
  it('stays pinned as rows arrive while the reader is at the bottom, and stops following once they scroll up', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });

    // New content, reader at the bottom: pinned to the new bottom before paint.
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: '↓ novas mensagens' })).toBeNull();

    // The reader scrolls up to read back through history.
    geo.scrollTop = 100;
    fireEvent.scroll(el);

    // A streamed line arrives: the thread must not move, and the pill says there is something new.
    geo.scrollHeight = 1200;
    rerender(<Thread followKey={3} rows={['a', 'b', 'c']} />);
    expect(geo.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('the pill scrolls smoothly to the bottom and the thread follows again', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
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

  it('re-pins when a row grows (a card, a thumbnail) through a ResizeObserver, but only while stuck', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    expect(FakeResizeObserver.callbacks.length).toBeGreaterThan(0);

    geo.scrollHeight = 1400;
    act(() => FakeResizeObserver.callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(geo.scrollTop).toBe(1400);

    geo.scrollTop = 200;
    fireEvent.scroll(el);
    geo.scrollHeight = 1800;
    act(() => FakeResizeObserver.callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(geo.scrollTop).toBe(200);
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(200);
  });

  it('a scroll-up in the same frame as a pin is the reader\'s: the position is kept and the pill shows', () => {
    // While an answer streams, a delta pins the thread every frame; a reader who scrolls up in one
    // of those frames must still unstick, or they could never read back during an answer.
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(1000);

    geo.scrollTop = 100;
    fireEvent.scroll(el);
    geo.scrollHeight = 1200;
    rerender(<Thread followKey={3} rows={['a', 'b', 'c']} />);
    expect(geo.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('a scroll-up right after a ResizeObserver re-pin is the reader\'s too', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    geo.scrollHeight = 1400;
    act(() => FakeResizeObserver.callbacks.forEach((cb) => cb([], {} as ResizeObserver)));
    expect(geo.scrollTop).toBe(1400);

    geo.scrollTop = 200;
    fireEvent.scroll(el);
    geo.scrollHeight = 1800;
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    expect(geo.scrollTop).toBe(200);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('a streamed answer that pins every frame does not trap a reader who keeps scrolling up', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    for (let frame = 0; frame < 11; frame += 1) {
      geo.scrollHeight += 100;
      rerender(<Thread followKey={frame + 2} rows={['a']} />);
      // The very first delta finds the reader at the bottom and pins; every later one must not.
      expect(geo.scrollTop).toBe(frame === 0 ? geo.scrollHeight : 100);
      geo.scrollTop = 100;
      fireEvent.scroll(el);
    }
    expect(geo.scrollTop).toBe(100);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('a scroll-up during the pill\'s smooth scroll ends it and unsticks', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    geo.scrollTop = 100;
    fireEvent.scroll(el);
    geo.scrollHeight = 1200;
    rerender(<Thread followKey={3} rows={['a', 'b', 'c']} />);
    (el as HTMLElement & { scrollTo: () => void }).scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: '↓ novas mensagens' }));

    // The smooth scroll's own events move down toward the bottom: not the reader's.
    geo.scrollTop = 400;
    fireEvent.scroll(el);
    // …then one moves up: the reader grabbed the thread.
    geo.scrollTop = 350;
    fireEvent.scroll(el);
    geo.scrollHeight = 1500;
    rerender(<Thread followKey={4} rows={['a', 'b', 'c', 'd']} />);
    expect(geo.scrollTop).toBe(350);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
  });

  it('shows the pill only when content arrived at the bottom, not on a card that merely changed', () => {
    const { rerender } = render(<Thread followKey={1} rows={['a']} />);
    const el = scroller();
    const geo = fakeGeometry(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 0 });
    rerender(<Thread followKey={2} rows={['a', 'b']} />);
    geo.scrollTop = 100;
    fireEvent.scroll(el);

    // Same rows, same height: a status flip on a card, nothing new to jump to.
    rerender(<Thread followKey={3} rows={['a', 'b']} />);
    expect(screen.queryByRole('button', { name: '↓ novas mensagens' })).toBeNull();
    // A streamed line grows the content without adding a row: that is news.
    geo.scrollHeight = 1200;
    rerender(<Thread followKey={4} rows={['a', 'b']} />);
    expect(screen.getByRole('button', { name: '↓ novas mensagens' })).toBeInTheDocument();
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
