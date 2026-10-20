import { projectAiResponse } from '@termhub/mobile-api';
import { chatHostStateSchema, chatResponse, emptyResponse, errorBody } from './local';

const conversation = {
  id: 'c1',
  title: null,
  project_id: null,
  machine_id: 'm1',
  ai_account_id: null,
  archived_at: null,
  last_message_at: '2026-09-24T12:00:00.000Z',
};

const readyHost = {
  kind: 'ready' as const,
  machine: { id: 'm1', name: 'jarvis' },
  configDir: null,
  account: { kind: 'default' as const },
  sessionAtStake: false,
};

const fixture = { conversation, messages: [], actions: [], grants: [], project_grants: [], standing_grants: [], tab_questions: [], tab_suggestions: [], tab_limits: [], subagents: [], open_answer_ids: [], host: readyHost };

describe('chatResponse', () => {
  it('parses a ready host', () => {
    expect(chatResponse.parse(fixture)).toEqual(fixture);
  });

  it('refuses a host kind it does not know', () => {
    const bad = { ...fixture, host: { kind: 'nope' } };
    expect(() => chatResponse.parse(bad)).toThrow();
  });

  it('defaults grants to empty when an older server sends none', () => {
    const { grants: _grants, ...withoutGrants } = fixture;
    expect(chatResponse.parse(withoutGrants)).toEqual(fixture);
  });

  it('defaults project_grants to empty when an older server sends none', () => {
    const { project_grants: _projectGrants, ...withoutProjectGrants } = fixture;
    expect(chatResponse.parse(withoutProjectGrants)).toEqual(fixture);
  });

  it('defaults standing_grants to empty when an older server sends none (TER-386)', () => {
    const { standing_grants: _standingGrants, ...withoutStandingGrants } = fixture;
    expect(chatResponse.parse(withoutStandingGrants)).toEqual(fixture);
  });

  it('defaults open_answer_ids to empty when an older server sends none (spec 2026-09-29)', () => {
    const { open_answer_ids: _openAnswerIds, ...withoutOpenAnswers } = fixture;
    expect(chatResponse.parse(withoutOpenAnswers)).toEqual(fixture);
  });

  it('keeps the open answer ids the server lists', () => {
    expect(chatResponse.parse({ ...fixture, open_answer_ids: ['a1', 'a2'] }).open_answer_ids).toEqual(['a1', 'a2']);
  });

  it('defaults tab_questions to empty when an older server sends none', () => {
    const { tab_questions: _tabQuestions, ...withoutTabQuestions } = fixture;
    expect(chatResponse.parse(withoutTabQuestions)).toEqual(fixture);
  });

  it('defaults tab_suggestions to empty when an older server sends none', () => {
    const { tab_suggestions: _tabSuggestions, ...withoutTabSuggestions } = fixture;
    expect(chatResponse.parse(withoutTabSuggestions)).toEqual(fixture);
  });

  it('defaults tab_limits to empty when an older server sends none (TER-589)', () => {
    const { tab_limits: _tabLimits, ...withoutTabLimits } = fixture;
    expect(chatResponse.parse(withoutTabLimits)).toEqual(fixture);
  });

  it('keeps the usage-limit cards the server lists (TER-589)', () => {
    const limit = {
      id: 'l1',
      tab_id: 't1',
      tab_name: 'api',
      payload: { account: { id: 'a1', label: 'Pessoal' }, machine: { id: 'm1', name: 'jarvis' }, resets_at: null, candidates: [{ id: 'a2', label: 'Trabalho' }] },
      status: 'open' as const,
      result: null,
      created_at: '2026-09-30T10:00:00.000Z',
      closed_at: null,
    };
    expect(chatResponse.parse({ ...fixture, tab_limits: [limit] }).tab_limits).toEqual([limit]);
  });

  it('defaults subagents to empty when an older server sends none (spec 2026-09-26 panel §4)', () => {
    const { subagents: _subagents, ...withoutSubagents } = fixture;
    expect(chatResponse.parse(withoutSubagents)).toEqual(fixture);
  });

  it("carries the context meter: the conversation's fill and compaction, and the person's limit (TER-1038)", () => {
    const parsed = chatResponse.parse({ ...fixture, conversation: { ...fixture.conversation, context_tokens: 150_000, context_window: 1_000_000, context_compacted_at: '2026-10-07T12:00:00.000Z' }, context_limit: 200_000 });
    expect(parsed.conversation).toMatchObject({ context_tokens: 150_000, context_window: 1_000_000, context_compacted_at: '2026-10-07T12:00:00.000Z' });
    expect(parsed.context_limit).toBe(200_000);
  });
});

describe('chatHostStateSchema', () => {
  it('accepts every variant of the union', () => {
    expect(chatHostStateSchema.safeParse(readyHost).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'no_machine' }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'not_chosen', machines: [{ id: 'm1', name: 'jarvis' }], sessionAtStake: true }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'offline', machine: { id: 'm1', name: 'jarvis' } }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'agent_too_old', machine: { id: 'm1', name: 'jarvis' }, version: '1.2.0' }).success).toBe(true);
  });

  it("keeps a chosen account's via: 'project', and parses one without it (TER-589)", () => {
    const viaProject = { ...readyHost, account: { kind: 'chosen' as const, id: 'a1', label: 'Trabalho', via: 'project' as const } };
    expect(chatHostStateSchema.parse(viaProject)).toEqual(viaProject);
    const chosen = { ...readyHost, account: { kind: 'chosen' as const, id: 'a1', label: 'Trabalho' } };
    expect(chatHostStateSchema.parse(chosen)).toEqual(chosen);
    expect(chatHostStateSchema.safeParse({ ...readyHost, account: { kind: 'chosen', id: 'a1', label: 'x', via: 'nope' } }).success).toBe(false);
  });
});

describe('projectAiResponse', () => {
  it('parses the accounts, the models and the available options', () => {
    const body = {
      ai: { accounts: ['a1'], models: { claude: 'opus', chatgpt: null } },
      available: [{ id: 'a1', label: 'Pessoal', provider: 'claude' as const, machine_id: 'm1', machine_name: 'jarvis', default: true }],
    };
    expect(projectAiResponse.parse(body)).toEqual(body);
  });
});

describe('errorBody', () => {
  it('parses the wire shape, attempts_left and retry_after optional', () => {
    expect(errorBody.parse({ error: 'Aparelho bloqueado', code: 'DEVICE_LOCKED' })).toEqual({ error: 'Aparelho bloqueado', code: 'DEVICE_LOCKED' });
    expect(errorBody.parse({ error: 'x', code: 'DEVICE_LOCKED', attempts_left: 2, retry_after: 900 })).toEqual({
      error: 'x',
      code: 'DEVICE_LOCKED',
      attempts_left: 2,
      retry_after: 900,
    });
  });
});

describe('emptyResponse', () => {
  it('accepts an empty body and any extra field', () => {
    expect(emptyResponse.parse({})).toEqual({});
    expect(emptyResponse.safeParse({ extra: true }).success).toBe(true);
  });
});
