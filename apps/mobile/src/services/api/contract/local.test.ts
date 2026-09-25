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

const fixture = { conversation, messages: [], actions: [], grants: [], host: readyHost };

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
});

describe('chatHostStateSchema', () => {
  it('accepts every variant of the union', () => {
    expect(chatHostStateSchema.safeParse(readyHost).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'no_machine' }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'not_chosen', machines: [{ id: 'm1', name: 'jarvis' }], sessionAtStake: true }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'offline', machine: { id: 'm1', name: 'jarvis' } }).success).toBe(true);
    expect(chatHostStateSchema.safeParse({ kind: 'agent_too_old', machine: { id: 'm1', name: 'jarvis' }, version: '1.2.0' }).success).toBe(true);
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
