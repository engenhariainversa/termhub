// Ported from apps/web/src/lib/chat-action-trail.test.ts: only the imports and the locale switch were adapted.
import { setLocale } from '@/i18n';
import type { ChatAction } from './types';
import { actionTrailSummary } from './action-trail';

const action = (over: Partial<ChatAction> = {}): ChatAction => ({
  id: 'a1',
  tool: 'close_tab',
  args: {},
  class: 'write',
  status: 'executed',
  machine_id: null,
  project_id: null,
  tab_id: null,
  grant_id: null,
  summary: 'fechar a aba «Figma»',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('actionTrailSummary (TER-1024)', () => {
  it('says how many ran and what they did', () => {
    expect(actionTrailSummary(Array.from({ length: 7 }, (_, i) => action({ id: `a${i}` })))).toBe('7 ações executadas · fechar aba ×7');
  });

  it('splits the outcomes when they differ, and names each kind of tool', () => {
    const actions = [action({ id: 'a1', tool: 'send_input' }), action({ id: 'a2', tool: 'send_input' }), action({ id: 'a3', status: 'denied' })];
    expect(actionTrailSummary(actions)).toBe('3 ações · 2 executadas, 1 recusada · digitar ×2, fechar aba');
  });

  it('reads a stale failure as expired, like the card does', () => {
    expect(actionTrailSummary([action({ id: 'a1', status: 'failed', error_code: 'TAB_GONE' }), action({ id: 'a2', status: 'expired' })])).toBe('2 ações expiradas · fechar aba ×2');
  });

  it('folds tools past the third into "+N", and keeps an unknown tool by its name', () => {
    const tools = ['send_input', 'run_command', 'send_key', 'open_tab', 'futuro_tool'];
    expect(actionTrailSummary(tools.map((tool, i) => action({ id: `a${i}`, tool })))).toBe('5 ações executadas · digitar, rodar comando, enviar tecla, +2 outras');
  });

  it('reads in English', () => {
    setLocale('en');
    try {
      const actions = [action({ id: 'a1' }), action({ id: 'a2' }), action({ id: 'a3', status: 'denied' })];
      expect(actionTrailSummary(actions)).toBe('3 actions · 2 run, 1 declined · close tab ×3');
    } finally {
      setLocale(null);
    }
  });
});
