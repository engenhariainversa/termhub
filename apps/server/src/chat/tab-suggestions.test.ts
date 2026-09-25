import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents } from '../agent/registry.js';
import type { Repositories } from '../db/repositories/index.js';
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import { chatBus, type ChatEvent } from './bus.js';

const captureStyledScreen = vi.fn();
vi.mock('../agent/screen.js', async (orig) => ({ ...(await orig<typeof import('../agent/screen.js')>()), captureStyledScreen: (...a: unknown[]) => captureStyledScreen(...a) }));

const { SUGGESTION_DELAY_MS, cancelTabSuggestion, checkTabSuggestion, cleanSuggestion, scheduleTabSuggestion, stopTabSuggestions } = await import('./tab-suggestions.js');

const fx = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures/tab-suggestions', name), 'utf8');
const screens = { suggestion: fx('screen-suggestion.ansi'), typed: fx('screen-typed.ansi') };

const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'api', kind: 'terminal', tmux_session: 'th-t1', state: 'waiting_input' };
const machine = { id: 'm1', type: 'agent', owner_id: 'u1' };
const opened = (over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 's1', tab_id: 't1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null,
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null, created_at: '2026-09-25T12:00:00.000Z', ...over,
});

function fakeRepos(opts: { tab?: object | undefined; conversation?: object | null } = {}) {
  const t = 'tab' in opts ? opts.tab : tab;
  const conversation = opts.conversation === undefined ? { id: 'c1', user_id: 'u1' } : (opts.conversation ?? undefined);
  return {
    tabs: { findById: vi.fn(async () => t), findByIdsForOwner: vi.fn(async () => [tab]) },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
    chat: { findLatestActiveForProject: vi.fn(async () => conversation) },
    machines: { findById: vi.fn(async () => machine) },
    tabQuestions: { open: vi.fn(async () => ({ question: opened(), closed: [] as TabQuestion[] })) },
  };
}
const asRepos = (r: ReturnType<typeof fakeRepos>) => r as unknown as Repositories;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
/** Only setTimeout is faked: setImmediate stays real, so `settle` lets every resolved mock run. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

let events: ChatEvent[];
let unsubscribe: () => void;
beforeEach(() => {
  captureStyledScreen.mockReset();
  captureStyledScreen.mockResolvedValue({ text: screens.suggestion, styled: true });
  vi.spyOn(agents, 'isOnline').mockReturnValue(true);
  events = [];
  unsubscribe = chatBus.subscribe((e) => events.push(e));
});
afterEach(() => {
  unsubscribe();
  stopTabSuggestions();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cleanSuggestion', () => {
  it('keeps one line of plain text, capped at 2000', () => {
    expect(cleanSuggestion('  commit\u0007 it ')).toBe('commit it');
    expect(cleanSuggestion('x'.repeat(2500))).toHaveLength(2000);
    expect(cleanSuggestion('\u0001 ')).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
  });
});

describe('checkTabSuggestion', () => {
  it("opens a suggestion row in the project's latest conversation and announces it on its own event", async () => {
    const repos = fakeRepos();
    const l = log();
    await checkTabSuggestion(asRepos(repos), l, 't1');
    expect(captureStyledScreen).toHaveBeenCalledWith(machine, 'th-t1', 15);
    expect(repos.chat.findLatestActiveForProject).toHaveBeenCalledWith('p1', 'u1');
    expect(repos.tabQuestions.open).toHaveBeenCalledWith({ tab_id: 't1', project_id: 'p1', conversation_id: 'c1', kind: 'suggestion', payload: { text: 'commit it' }, tool_use_id: null });
    expect(events).toEqual([expect.objectContaining({ type: 'tab_suggestion', user_id: 'u1', conversation_id: 'c1', suggestion: expect.objectContaining({ id: 's1', tab_name: 'api', kind: 'suggestion' }) })]);
    expect(l.info).toHaveBeenCalledWith({ tabId: 't1', tabQuestionId: 's1', kind: 'suggestion', chars: 9 }, 'tab suggestion opened');
    expect(JSON.stringify(l.info.mock.calls)).not.toContain('commit');
  });

  it.each([
    ['text the person typed', { text: screens.typed, styled: true }],
    ['an older agent (plain capture)', { text: 'x\n❯ commit it\n', styled: false }],
    // Seen live (Claude Code 2.1.283): "/compact" as the suggestion. Sending refuses a leading / or !,
    // so such a card could only fail.
    ['a slash command', { text: 'x\n\x1b[39m❯ \x1b[2m/compact\x1b[0m\n', styled: true }],
    ['a bash command', { text: 'x\n\x1b[39m❯ \x1b[2m!git status\x1b[0m\n', styled: true }],
    ['a spaced bash command', { text: 'x\n\x1b[39m❯ \x1b[2m! git status\x1b[0m\n', styled: true }],
  ])('opens nothing for %s', async (_label, shot) => {
    captureStyledScreen.mockResolvedValue(shot);
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1');
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('reads nothing when the tab is gone or busy again, the project has no conversation, or the agent is offline', async () => {
    await checkTabSuggestion(asRepos(fakeRepos({ tab: undefined })), log(), 't1');
    await checkTabSuggestion(asRepos(fakeRepos({ tab: { ...tab, state: 'working' } })), log(), 't1');
    await checkTabSuggestion(asRepos(fakeRepos({ conversation: null })), log(), 't1');
    vi.mocked(agents.isOnline).mockReturnValue(false);
    await checkTabSuggestion(asRepos(fakeRepos()), log(), 't1');
    expect(captureStyledScreen).not.toHaveBeenCalled();
  });

  it('opens nothing when the tab moved while its screen was read', async () => {
    const repos = fakeRepos();
    await checkTabSuggestion(asRepos(repos), log(), 't1', () => false);
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });

  it('never throws, and logs by code only', async () => {
    captureStyledScreen.mockRejectedValueOnce(Object.assign(new Error('❯ commit it'), { code: 'MACHINE_FAILED' }));
    const l = log();
    await expect(checkTabSuggestion(asRepos(fakeRepos()), l, 't1')).resolves.toBeUndefined();
    expect(l.warn).toHaveBeenCalledWith({ tabId: 't1', code: 'MACHINE_FAILED' }, 'tab suggestion check failed');
  });
});

describe('scheduleTabSuggestion', () => {
  it('waits 5 s: the suggestion was seen drawn 1.5–2.8 s after the Stop', () => {
    expect(SUGGESTION_DELAY_MS).toBe(5000);
  });

  it(`reads the prompt ${SUGGESTION_DELAY_MS} ms after the Stop, not before`, async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('any event of the tab meanwhile cancels it', async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(1000);
    cancelTabSuggestion('t1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(repos.tabs.findById).not.toHaveBeenCalled();
  });

  it("a second Stop restarts the wait; another tab's event does not touch it", async () => {
    fakeTimers();
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1000);
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    cancelTabSuggestion('t2');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS - 1);
    expect(repos.tabs.findById).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(repos.tabQuestions.open).toHaveBeenCalledTimes(1);
  });

  it('an event that arrives while the screen is being read keeps the row from opening', async () => {
    fakeTimers();
    let release!: (v: unknown) => void;
    captureStyledScreen.mockReturnValue(new Promise((r) => (release = r)));
    const repos = fakeRepos();
    scheduleTabSuggestion(asRepos(repos), log(), 't1');
    await vi.advanceTimersByTimeAsync(SUGGESTION_DELAY_MS);
    await settle();
    expect(captureStyledScreen).toHaveBeenCalled();
    cancelTabSuggestion('t1');
    release({ text: screens.suggestion, styled: true });
    await settle();
    expect(repos.tabQuestions.open).not.toHaveBeenCalled();
  });
});
