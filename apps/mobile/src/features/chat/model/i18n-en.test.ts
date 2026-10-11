// The chat's model copy in English (i18n spec 2026-10-04): the same functions the pt-BR tests cover,
// read with the app set to English.
import { setLocale } from '@/i18n';
import { formatBytes, attachmentStatusText } from '../viewmodel/attachments';
import { failureSentence, hostLine } from './copy';
import { CHAT_MSG } from './messages';
import { limitSentence, resetClause } from './notice';
import { REPLY_AUTHOR, replyLabel } from './reply';
import { SUBAGENT_STATUS_LABEL } from './subagents';
import { tabLimitStatusLabel, tabLimitText } from './tab-limit-text';
import type { TabLimit } from './types';

const NOW = new Date('2026-09-30T08:56:00.000Z');
const TZ = 'America/Sao_Paulo';

afterEach(() => setLocale(null));

describe('chat model copy in English', () => {
  beforeEach(() => setLocale('en'));

  it('reads CHAT_MSG in the language the app shows at that moment', () => {
    expect(CHAT_MSG.busy).toBe('The chat is still answering. Please wait.');
    setLocale('pt-BR');
    expect(CHAT_MSG.busy).toBe('O chat ainda está respondendo. Aguarde.');
  });

  it('explains a stopped answer and where the chat runs', () => {
    expect(failureSentence('HOST_GONE')).toBe('The chat\'s machine went offline in the middle of the answer. Turn it on and send the message again.');
    expect(failureSentence('SOMETHING_NEW')).toBe('The answer did not finish — try again.');
    expect(hostLine({ kind: 'offline', machine: { name: 'hulk' } } as never).text).toBe('The machine hulk is offline right now.');
  });

  it('writes the usage-limit notice with the date in English order', () => {
    expect(resetClause('2026-10-01T06:20:00.000Z', NOW, TZ)).toBe('on 10/01 at 03:20');
    expect(limitSentence({ kind: 'usage_limit', account: 'Personal', resets_at: '2026-09-30T20:20:00.000Z', fallback: 'none_free' }, NOW, TZ)).toBe(
      'The Claude account "Personal" hit its usage limit and resets at 17:20. No other Claude account on this machine has usage left right now.',
    );
  });

  it('writes the tab limit card', () => {
    const limit = {
      id: 'l1',
      status: 'open',
      result: null,
      tab_name: 'api',
      payload: { account: { id: 'a1', label: 'Work' }, resets_at: null, machine: { name: 'hulk' }, candidates: [] },
    } as unknown as TabLimit;
    expect(tabLimitText(limit)).toBe('The account Work of the tab api hit its usage limit (token quota used up). Automatic switching is off on the machine hulk.');
    expect(tabLimitStatusLabel({ ...limit, status: 'dismissed' } as TabLimit)).toBe('You chose to wait for the limit to reset.');
  });

  it('labels quotes and subagents', () => {
    expect(REPLY_AUTHOR.user).toBe('You');
    expect(replyLabel({ role: 'assistant', card: 'tab_question' })).toBe('Tab question');
    expect(SUBAGENT_STATUS_LABEL.running).toBe('running');
  });

  it('formats sizes with the English decimal point', () => {
    expect(formatBytes(1229)).toBe('1.2 KB');
    expect(formatBytes(512)).toBe('512 B');
    expect(attachmentStatusText({ kind: 'pdf', status: 'failed', error_code: 'ATTACHMENT_INVALID' } as never)).toBe('failed: invalid file');
    setLocale('pt-BR');
    expect(formatBytes(1229)).toBe('1,2 KB');
  });
});
