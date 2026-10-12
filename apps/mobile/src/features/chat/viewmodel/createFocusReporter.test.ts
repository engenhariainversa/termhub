// The focus reporter over a hand-made `api` fake and the app's own signals, on fake timers.
import { appBackgrounded, appForegrounded, sessionEnded, sessionStarted } from '@/features/shared/signals';
import { createFocusReporter } from './createFocusReporter';

function setup(opts: { active?: boolean; signedIn?: boolean; reportChatFocus?: jest.Mock } = {}) {
  const state = { active: opts.active ?? true, signedIn: opts.signedIn ?? true };
  const reportChatFocus = opts.reportChatFocus ?? jest.fn(async () => undefined);
  const reporter = createFocusReporter({
    api: { reportChatFocus },
    session: () => ({
      auth: () => {
        if (!state.signedIn) throw new Error('LOCKED');
        return { accessToken: 'tok' };
      },
    }),
    clientId: 'client-0001',
    active: () => state.active,
    beatMs: 15_000,
  });
  return { state, reportChatFocus, reporter };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

let current: ReturnType<typeof setup> | null = null;
const start = (opts?: Parameters<typeof setup>[0]) => (current = setup(opts));

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  current?.reporter.stop();
  current = null;
  jest.useRealTimers();
});

it('reports focus at once and beats every 15 s while the app is in the foreground', async () => {
  const { reportChatFocus } = start();
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(1);
  expect(reportChatFocus).toHaveBeenLastCalledWith({ accessToken: 'tok' }, 'client-0001', true);
  jest.advanceTimersByTime(30_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(3);
});

it('says "not in focus" once when the app leaves the foreground, stops beating, and resumes on the way back', async () => {
  const { reportChatFocus } = start();
  appBackgrounded.emit();
  appBackgrounded.emit(); // `inactive` then `background`: one report
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(2);
  expect(reportChatFocus).toHaveBeenLastCalledWith(expect.anything(), 'client-0001', false);
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(2);
  appForegrounded.emit();
  await flush();
  expect(reportChatFocus).toHaveBeenLastCalledWith(expect.anything(), 'client-0001', true);
  jest.advanceTimersByTime(15_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(4);
});

it('sends nothing without a session, and starts when one does', async () => {
  const { state, reportChatFocus } = start({ signedIn: false });
  jest.advanceTimersByTime(45_000);
  appBackgrounded.emit();
  appForegrounded.emit();
  await flush();
  expect(reportChatFocus).not.toHaveBeenCalled();
  state.signedIn = true;
  sessionStarted.emit();
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(1);
  expect(reportChatFocus).toHaveBeenLastCalledWith(expect.anything(), 'client-0001', true);
});

it('a session started in the background reports nothing until the app is in the foreground', async () => {
  const { state, reportChatFocus } = start({ active: false });
  sessionStarted.emit();
  await flush();
  expect(reportChatFocus).not.toHaveBeenCalled();
  state.active = true;
  appForegrounded.emit();
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(1);
});

it('stops when the session ends', async () => {
  const { state, reportChatFocus } = start();
  await flush();
  state.signedIn = false;
  sessionEnded.emit();
  jest.advanceTimersByTime(60_000);
  appBackgrounded.emit();
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(1);
});

it('swallows a failed report and keeps beating', async () => {
  const reportChatFocus = jest.fn(async () => {
    throw new Error('offline');
  });
  start({ reportChatFocus });
  await flush();
  jest.advanceTimersByTime(15_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(2);
});

it('goes quiet while the session is locked and reports again on the unlock', async () => {
  const { state, reportChatFocus } = start();
  await flush();
  state.signedIn = false;
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(1);
  state.signedIn = true;
  sessionStarted.emit();
  jest.advanceTimersByTime(15_000);
  await flush();
  expect(reportChatFocus).toHaveBeenCalledTimes(3);
  expect(reportChatFocus).toHaveBeenLastCalledWith(expect.anything(), 'client-0001', true);
});
