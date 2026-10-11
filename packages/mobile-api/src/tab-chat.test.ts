import { describe, expect, it } from 'vitest';
import {
  startSessionBody,
  tabActionBody,
  tabChatFrame,
  tabChatItems,
  tabChatPage,
  tabMessageBody,
  tabScreenQuery,
  tabSummary,
} from './tab-chat.js';

const summary = {
  id: 't1',
  name: 'claude',
  project: { id: 'p1', key: 'TER', name: 'termhub' },
  machine: { id: 'm1', name: 'jarvis' },
  state: 'working',
  state_at: '2026-10-01T10:00:00.000Z',
  needs_you: false,
  activity: 'Bash',
  activity_verb: null,
  availability: 'ready',
};
const user = { kind: 'user', id: 'u1', at: '2026-10-01T10:00:00.000Z', text: 'oi', images: 0 };

describe('tab chat contract', () => {
  it('a message body takes 1 to 4000 characters', () => {
    expect(tabMessageBody.safeParse({ text: 'x' }).success).toBe(true);
    expect(tabMessageBody.safeParse({ text: 'x'.repeat(4000) }).success).toBe(true);
    expect(tabMessageBody.safeParse({ text: '' }).success).toBe(false);
    expect(tabMessageBody.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('a new session needs a project and a prompt', () => {
    expect(startSessionBody.safeParse({ project_id: 'p1', prompt: 'oi' }).success).toBe(true);
    expect(startSessionBody.safeParse({ project_id: 'p1', machine_id: 'm1', prompt: 'oi' }).success).toBe(true);
    expect(startSessionBody.safeParse({ project_id: 'p1' }).success).toBe(false);
    expect(startSessionBody.safeParse({ project_id: '', prompt: 'oi' }).success).toBe(false);
    expect(startSessionBody.safeParse({ project_id: 'p1', prompt: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('an action is one of the list', () => {
    for (const action of ['interrupt', 'cycle_mode', 'clear', 'compact']) expect(tabActionBody.safeParse({ action }).success).toBe(true);
    expect(tabActionBody.safeParse({ action: 'rm' }).success).toBe(false);
  });

  it('screen lines default to 60 and stop at 200', () => {
    expect(tabScreenQuery.parse({})).toEqual({ lines: 60 });
    expect(tabScreenQuery.parse({ lines: '120' })).toEqual({ lines: 120 });
    expect(tabScreenQuery.safeParse({ lines: '500' }).success).toBe(false);
  });

  it('drops an item of a kind it does not know instead of failing', () => {
    expect(tabChatItems.parse([user, { kind: 'hologram', id: 'x' }, 7])).toEqual([user]);
    const page = tabChatPage.parse({
      tab: summary, session_id: null, items: [user, { kind: 'later' }], before: null, live: null, mode: null, degraded: false, questions: [], suggestions: [],
    });
    expect(page.items).toEqual([user]);
  });

  it('a tab summary takes an availability the enum does not list', () => {
    expect(tabSummary.parse({ ...summary, availability: 'something_new' }).availability).toBe('something_new');
    expect(tabSummary.parse(summary).background).toBe(false);
    expect(tabSummary.parse(summary).finished).toBe(false);
  });

  it('parses one frame of each type and refuses an unknown one', () => {
    const frames = [
      { type: 'hello', protocol: 1, server_time: '2026-10-01T10:00:00.000Z', availability: 'ready' },
      { type: 'items', items: [user], live: 's.10', mode: 'plan' },
      { type: 'state', tab: summary },
      { type: 'reset', session_id: null },
      { type: 'unavailable', availability: 'offline' },
    ];
    for (const f of frames) expect(tabChatFrame.safeParse(f).success).toBe(true);
    expect(tabChatFrame.safeParse({ type: 'later' }).success).toBe(false);
  });
});
