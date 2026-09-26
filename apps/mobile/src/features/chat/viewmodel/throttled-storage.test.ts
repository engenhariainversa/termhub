import type { StateStorage } from 'zustand/middleware';
import { createThrottledStorage, PERSIST_INTERVAL_MS } from './throttled-storage';

/** An in-memory `StateStorage` that counts its writes. */
function memory() {
  const items = new Map<string, string>();
  const writes: string[] = [];
  const backing: StateStorage = {
    getItem: (name) => items.get(name) ?? null,
    setItem: (name, value) => {
      items.set(name, value);
      writes.push(value);
    },
    removeItem: (name) => {
      items.delete(name);
    },
  };
  return { backing, items, writes };
}

const value = (n: number) => ({ state: { n }, version: 0 });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.useRealTimers();
});

it('writes the first value at once, then coalesces a burst into one write per interval, keeping the latest', () => {
  const { backing, writes } = memory();
  const storage = createThrottledStorage<{ n: number }>(backing);

  storage.setItem('chat', value(1));
  expect(writes).toEqual([]); // never synchronously: a burst of sets costs one timer
  jest.advanceTimersByTime(0);
  expect(writes).toEqual([JSON.stringify(value(1))]);

  for (let i = 2; i <= 50; i++) storage.setItem('chat', value(i));
  jest.advanceTimersByTime(PERSIST_INTERVAL_MS - 1);
  expect(writes).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toBe(JSON.stringify(value(50)));
});

it('flush() writes what is pending right away and cancels the scheduled write', () => {
  const { backing, writes, items } = memory();
  const storage = createThrottledStorage<{ n: number }>(backing);

  storage.setItem('chat', value(1));
  storage.flush();
  expect(writes).toEqual([JSON.stringify(value(1))]);
  jest.advanceTimersByTime(PERSIST_INTERVAL_MS);
  expect(writes).toHaveLength(1);

  storage.flush(); // nothing pending: no write
  expect(writes).toHaveLength(1);
  expect(items.get('chat')).toBe(JSON.stringify(value(1)));
});

it('getItem parses what the backing store holds; removeItem drops the pending value too', () => {
  const { backing, items, writes } = memory();
  const storage = createThrottledStorage<{ n: number }>(backing);

  expect(storage.getItem('chat')).toBeNull();
  items.set('chat', JSON.stringify(value(7)));
  expect(storage.getItem('chat')).toEqual(value(7));
  items.set('chat', '{not json');
  expect(storage.getItem('chat')).toBeNull();

  storage.setItem('chat', value(8));
  storage.removeItem('chat');
  jest.advanceTimersByTime(PERSIST_INTERVAL_MS);
  expect(writes).toEqual([]);
  expect(items.has('chat')).toBe(false);
});
