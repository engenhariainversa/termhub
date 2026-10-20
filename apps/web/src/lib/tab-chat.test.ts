import { describe, expect, it } from 'vitest';
import { availabilityText, buildRows, canType, cliName, mergeItems, modeLabel, startAgentPlan, stateLine, withAttachedPaths } from './tab-chat';
import { applyFrame, becameReadable, fromPage, initialTabChat } from './use-tab-chat';
import type { TabAgentChoice, TabChatItem, TabChatPage, TabChatSummary } from './types';

const at = '2026-10-07T10:00:00.000Z';
const user = (id: string, text: string): TabChatItem => ({ kind: 'user', id, at, text, images: 0 });
const assistant = (id: string, text: string): TabChatItem => ({ kind: 'assistant', id, at, text });
const tool = (id: string, name: string, summary: string | null = null): TabChatItem => ({ kind: 'tool', id, at, name, summary });
const result = (id: string, toolId: string, error = false, preview: string | null = 'ok'): TabChatItem => ({ kind: 'tool_result', id, at, tool_id: toolId, error, preview });

describe('mergeItems', () => {
  it('appends new items and replaces known ones in place', () => {
    const merged = mergeItems([user('a', 'oi'), assistant('b', 'olá')], [assistant('b', 'olá!'), user('c', 'e aí')], 'append');
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1]).toMatchObject({ text: 'olá!' });
  });

  it('prepends an earlier page without repeating what is already there', () => {
    const merged = mergeItems([user('b', 'x')], [user('a', 'y'), user('b', 'x'), user('a', 'y')], 'prepend');
    expect(merged.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('keeps the same array when nothing comes in', () => {
    const current = [user('a', 'oi')];
    expect(mergeItems(current, [], 'append')).toBe(current);
  });
});

describe('buildRows', () => {
  it('folds consecutive tools in one row, marked by their results', () => {
    const rows = buildRows([user('u', 'roda'), tool('t1', 'Bash', 'ls'), result('r1', 't1'), tool('t2', 'Read', '/a.ts'), result('r2', 't2', true, 'boom'), assistant('a', 'pronto')], false);
    expect(rows.map((r) => r.kind)).toEqual(['message', 'tools', 'message']);
    const tools = rows[1] as Extract<(typeof rows)[number], { kind: 'tools' }>;
    expect(tools.tools.map((t) => [t.name, t.summary, t.status, t.preview])).toEqual([
      ['Bash', 'ls', 'done', 'ok'],
      ['Read', '/a.ts', 'error', 'boom'],
    ]);
  });

  it('a tool with no result runs while the tab works, and is done otherwise', () => {
    expect((buildRows([tool('t', 'Bash')], true)[0] as { tools: { status: string }[] }).tools[0]!.status).toBe('running');
    expect((buildRows([tool('t', 'Bash')], false)[0] as { tools: { status: string }[] }).tools[0]!.status).toBe('done');
  });

  it('a subagent is a row of its own, with its report', () => {
    const rows = buildRows([tool('t1', 'Bash'), tool('s', 'Agent', 'Revisar o PR'), result('rs', 's', false, '## Relatório'), tool('t2', 'Grep')], false);
    expect(rows.map((r) => r.kind)).toEqual(['tools', 'subagent', 'tools']);
    expect(rows[1]).toMatchObject({ kind: 'subagent', tool: { summary: 'Revisar o PR', preview: '## Relatório', status: 'done' } });
  });

  it('commands, their output and notices are small lines', () => {
    const rows = buildRows(
      [
        { kind: 'command', id: 'c', at, name: '/compact', args: null },
        { kind: 'command_output', id: 'o', at, text: 'Compacted' },
        { kind: 'notice', id: 'n', at, notice: 'interrupted' },
      ],
      false,
    );
    expect(rows.map((r) => (r.kind === 'line' ? r.text : r.kind))).toEqual(['/compact', 'Compacted', 'Interrompido']);
  });
});

describe('labels', () => {
  it('reads the mode, and says nothing for an unknown footer', () => {
    expect(modeLabel('acceptEdits')).toBe('Aceitar edições');
    expect(modeLabel('auto')).toBe('Automático');
    expect(modeLabel('newMode')).toBe('newMode');
    expect(modeLabel('unknown')).toBeNull();
    expect(modeLabel(null)).toBeNull();
  });

  it('says why a tab cannot be read, and an old agent is told to update', () => {
    expect(availabilityText('ready')).toBeNull();
    expect(availabilityText('agent_outdated')).toBe('Atualize o agente desta máquina');
    expect(availabilityText('something_new')).toBe('Indisponível no momento');
    // TER-1095: a Codex tab with untrusted hooks says how to trust them; any other reason keeps the line
    expect(availabilityText('no_session', 'codex_untrusted')).toContain('Trust all');
    expect(availabilityText('no_session', 'not_reported')).toBe('Nenhuma sessão informada nesta aba');
  });

  it('only an offline machine stops the box', () => {
    expect(canType('ready')).toBe(true);
    expect(canType('agent_outdated')).toBe(true);
    expect(canType('offline')).toBe(false);
  });

  it("puts the tab's state in one line", () => {
    const base = { state: null, background: false, finished: false, needs_you: false, activity: null } as Pick<TabChatSummary, 'state' | 'background' | 'finished' | 'needs_you' | 'activity'>;
    expect(stateLine({ ...base, state: 'working', activity: 'Bash' })).toBe('Trabalhando · Bash');
    expect(stateLine({ ...base, state: 'working', background: true })).toBe('Em segundo plano');
    expect(stateLine({ ...base, state: 'waiting_permission' })).toBe('Esperando você');
    expect(stateLine({ ...base, state: 'idle', finished: true })).toBe('Concluído');
    expect(stateLine({ ...base, state: 'idle' })).toBe('Parado');
  });

  it('puts the attached paths at the end of the message', () => {
    expect(withAttachedPaths(' veja ', ['/p/a.png', '/p/b.md'])).toBe('veja\n\n/p/a.png /p/b.md');
    expect(withAttachedPaths('', ['/p/a.png'])).toBe('/p/a.png');
    expect(withAttachedPaths('só texto', [])).toBe('só texto');
  });
});

describe('applyFrame', () => {
  it('merges live items and keeps the last mode when a frame has none', () => {
    const s = { ...initialTabChat(), items: [user('a', 'oi')], mode: 'plan' };
    const next = applyFrame(s, { type: 'items', items: [assistant('b', 'olá')], live: 'sid.10', mode: null });
    expect(next.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(next.live).toBe('sid.10');
    expect(next.mode).toBe('plan');
  });

  it('takes the availability from hello, state and unavailable', () => {
    expect(applyFrame(initialTabChat(), { type: 'hello', protocol: 1, server_time: at, availability: 'agent_outdated' }).availability).toBe('agent_outdated');
    expect(applyFrame(initialTabChat(), { type: 'unavailable', availability: 'offline' }).availability).toBe('offline');
  });
});

describe('becameReadable (TER-1091)', () => {
  const noSession = { ...initialTabChat(), status: 'ready' as const, availability: 'no_session', live: null };
  const hello = (availability: string) => ({ type: 'hello' as const, protocol: 1, server_time: at, availability });

  it('a page with no transcript followed re-reads when the tab turns ready', () => {
    expect(becameReadable(noSession, hello('ready'))).toBe(true);
  });

  it('never while a transcript is followed, while loading, or for another availability', () => {
    expect(becameReadable({ ...noSession, live: 'sid.10' }, hello('ready'))).toBe(false);
    expect(becameReadable({ ...noSession, status: 'loading' }, hello('ready'))).toBe(false);
    expect(becameReadable(noSession, hello('offline'))).toBe(false);
    expect(becameReadable({ ...noSession, availability: 'ready' }, hello('ready'))).toBe(false);
  });
});

describe('a tab with no agent (TER-1094)', () => {
  const claude: TabAgentChoice = { account_id: 'a1', label: 'Pessoal', provider: 'claude', model: 'opus' };
  const codex: TabAgentChoice = { account_id: 'a2', label: 'Trabalho', provider: 'chatgpt', model: null };

  it("keeps the page's empty_reason, and drops it once items arrive", () => {
    const page = { tab: { availability: 'no_session' }, session_id: null, items: [], before: null, live: null, mode: null, degraded: false, questions: [], suggestions: [], empty_reason: 'no_agent' } as unknown as TabChatPage;
    const s = { ...initialTabChat(), ...fromPage(page) };
    expect(s.emptyReason).toBe('no_agent');
    expect(fromPage({ ...page, empty_reason: undefined }).emptyReason).toBeNull();
    expect(applyFrame(s, { type: 'items', items: [assistant('b', 'olá')], live: 'sid.10', mode: null }).emptyReason).toBeNull();
    expect(applyFrame(s, { type: 'items', items: [], live: 'sid.10', mode: null }).emptyReason).toBe('no_agent');
  });

  it('offers the suggested account with the others behind it, the list when none is suggested, or nothing', () => {
    expect(startAgentPlan({ choices: [claude, codex], suggested: 'a2' })).toEqual({ kind: 'suggested', choice: codex, others: [claude] });
    expect(startAgentPlan({ choices: [claude, codex], suggested: null })).toEqual({ kind: 'choose', choices: [claude, codex] });
    // a suggestion that is not among the choices is no suggestion
    expect(startAgentPlan({ choices: [claude], suggested: 'gone' })).toEqual({ kind: 'choose', choices: [claude] });
    expect(startAgentPlan({ choices: [], suggested: null })).toEqual({ kind: 'none' });
  });

  it('names the CLI of each provider', () => {
    expect(cliName('claude')).toBe('Claude Code');
    expect(cliName('chatgpt')).toBe('Codex');
    expect(cliName('gemini')).toBe('gemini');
  });
});
