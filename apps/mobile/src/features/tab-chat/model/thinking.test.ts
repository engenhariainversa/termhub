import { setLocale } from '@/i18n';
import { activityLabel } from './activity-label';
import { agentName } from './agent-label';
import { thinkingLine } from './thinking';
import type { Row, ToolRow } from './timeline';

const tab = (p: Partial<Parameters<typeof thinkingLine>[0] & object> = {}) => ({ state: 'working' as const, background: false, activity: null, ...p });
const tools = (...list: Partial<ToolRow>[]): Row => ({ kind: 'tools', id: 'tools:1', tools: list.map((x, i) => ({ id: `t${i}`, name: 'Bash', summary: null, status: 'done', preview: null, ...x })) });
const message: Row = { kind: 'message', id: 'm1', role: 'assistant', text: 'Vou ler a estrutura.', images: 0, at: '' };

describe('thinkingLine', () => {
  it('says "pensando…" while the agent works, with nothing else known (Codex with its hooks not trusted)', () => {
    expect(thinkingLine(tab(), [])).toBe('pensando…');
    expect(thinkingLine(tab(), [message])).toBe('pensando…');
  });

  it("adds what the agent does from the tab's activity: Codex's tools reach the history only once they end", () => {
    expect(thinkingLine(tab({ activity: 'terminal' }), [message, tools({ summary: 'rg -n TODO', status: 'done' })])).toBe('pensando… · rodando comandos');
    expect(thinkingLine(tab({ activity: 'coding' }), [message])).toBe('pensando… · editando arquivos');
    expect(thinkingLine(tab({ activity: 'working' }), [message])).toBe('pensando…');
  });

  it("names the tool running at the end of the history (Claude Code writes the call as it starts)", () => {
    expect(thinkingLine(tab({ activity: 'terminal' }), [tools({ status: 'done' }, { name: 'Bash', summary: 'npm test', status: 'running' })])).toBe('executando Bash · npm test…');
    expect(thinkingLine(tab(), [tools({ name: 'Read', status: 'running' })])).toBe('executando Read…');
  });

  it('is gone once the turn ends, and while the agent only waits on its background work', () => {
    for (const state of ['waiting_input', 'waiting_permission', 'idle', 'error', null] as const) expect(thinkingLine(tab({ state }), [message])).toBeNull();
    expect(thinkingLine(tab({ background: true }), [message])).toBeNull();
    expect(thinkingLine(null, [])).toBeNull();
  });

  describe('in English', () => {
    beforeEach(() => setLocale('en'));
    afterEach(() => setLocale(null));

    it('says it in English', () => {
      expect(thinkingLine(tab({ activity: 'terminal' }), [])).toBe('thinking… · running commands');
      expect(thinkingLine(tab(), [tools({ name: 'Bash', summary: 'ls', status: 'running' })])).toBe('running Bash · ls…');
    });
  });
});

describe('activityLabel', () => {
  it('reads the server activities, and a value a newer server adds as itself', () => {
    expect(activityLabel('terminal')).toBe('rodando comandos');
    expect(activityLabel('reading')).toBe('lendo arquivos');
    expect(activityLabel('researching')).toBe('pesquisando');
    expect(activityLabel('planning')).toBe('planejando');
    expect(activityLabel('dreaming')).toBe('dreaming');
    expect(activityLabel('working')).toBeNull();
    expect(activityLabel(null)).toBeNull();
  });
});

describe('agentName', () => {
  it('names the CLI; none reported reads as Claude Code, an unknown one as itself', () => {
    expect(agentName('codex')).toBe('Codex');
    expect(agentName('claude')).toBe('Claude Code');
    expect(agentName(null)).toBe('Claude Code');
    expect(agentName('gemini')).toBe('gemini');
  });
});
