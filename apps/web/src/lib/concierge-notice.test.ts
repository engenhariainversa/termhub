// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conciergeNoticeText, publishConciergeNotice, showConciergeNotice, subscribeConciergeNotices, type ConciergeNoticeEvent } from './concierge-notice';

const shown: { title: string; opts: NotificationOptions; instance: { onclick: (() => void) | null; close: () => void } }[] = [];
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, opts: NotificationOptions) {
    shown.push({ title, opts, instance: this });
  }
}

const notice = (over: Partial<ConciergeNoticeEvent> = {}): ConciergeNoticeEvent => ({
  type: 'concierge_notice', conversation_id: 'c1', project_id: 'p1', message_id: 'm1', level: 'needs_you', headline: 'O deploy falhou', count: 1, ...over,
});

beforeEach(() => {
  shown.length = 0;
  FakeNotification.permission = 'granted';
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => vi.unstubAllGlobals());

describe('concierge notices in the browser (TER-1101)', () => {
  it('words: the level, then the concierge\'s headline and how many more it carries', () => {
    expect(conciergeNoticeText(notice())).toEqual({ title: 'O concierge precisa de você', body: 'O deploy falhou' });
    expect(conciergeNoticeText(notice({ level: 'done', headline: 'Build pronto', count: 3 }))).toEqual({ title: 'Novidade do concierge', body: 'Build pronto (+2 avisos)' });
  });

  it('shows one per conversation (tag), and a click opens the chat at the message', () => {
    const onOpen = vi.fn();
    expect(showConciergeNotice(notice(), { chatOnScreen: false, onOpen })).toBe(true);
    expect(shown[0]).toMatchObject({ title: 'O concierge precisa de você', opts: { body: 'O deploy falhou', tag: 'concierge:c1' } });
    shown[0].instance.onclick?.();
    expect(onOpen).toHaveBeenCalled();
    expect(shown[0].instance.close).toHaveBeenCalled();
  });

  it('nothing without the permission, nor while the person is looking at that chat', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(showConciergeNotice(notice(), { chatOnScreen: true, onOpen: () => {} })).toBe(false);
    expect(showConciergeNotice(notice(), { chatOnScreen: false, onOpen: () => {} })).toBe(true);
    FakeNotification.permission = 'default';
    expect(showConciergeNotice(notice(), { chatOnScreen: false, onOpen: () => {} })).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('the feed hands each notice to whoever listens', () => {
    const got: ConciergeNoticeEvent[] = [];
    const off = subscribeConciergeNotices((e) => got.push(e));
    publishConciergeNotice(notice());
    off();
    publishConciergeNotice(notice());
    expect(got).toHaveLength(1);
  });
});
