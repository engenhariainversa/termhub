import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFocusReporter, focusClientId } from './chat-focus';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('says nothing while the screen was never in focus', () => {
  const send = vi.fn();
  const reporter = createFocusReporter(send, 15_000);
  reporter.set(false);
  vi.advanceTimersByTime(60_000);
  reporter.stop();
  expect(send).not.toHaveBeenCalled();
});

it('reports gaining focus at once, beats while focused, and reports losing it once', () => {
  const send = vi.fn();
  const reporter = createFocusReporter(send, 15_000);
  reporter.set(true);
  reporter.set(true); // the same reading again (focus + visibilitychange together) sends nothing
  expect(send.mock.calls).toEqual([[true]]);
  vi.advanceTimersByTime(30_000);
  expect(send.mock.calls).toEqual([[true], [true], [true]]);
  reporter.set(false);
  reporter.set(false);
  expect(send).toHaveBeenLastCalledWith(false);
  expect(send).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(60_000); // out of focus: no beat
  expect(send).toHaveBeenCalledTimes(4);
});

it('beats again after focus comes back, from that moment', () => {
  const send = vi.fn();
  const reporter = createFocusReporter(send, 15_000);
  reporter.set(true);
  vi.advanceTimersByTime(10_000);
  reporter.set(false);
  reporter.set(true);
  send.mockClear();
  vi.advanceTimersByTime(14_999);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(send.mock.calls).toEqual([[true]]);
});

it('stop takes the focus back when the screen had it, and ends the beat', () => {
  const send = vi.fn();
  const reporter = createFocusReporter(send, 15_000);
  reporter.set(true);
  reporter.stop();
  expect(send.mock.calls).toEqual([[true], [false]]);
  vi.advanceTimersByTime(60_000);
  expect(send).toHaveBeenCalledTimes(2);
});

it('keeps one client id for the page, in the alphabet the server accepts', () => {
  const id = focusClientId();
  expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  expect(focusClientId()).toBe(id);
});
