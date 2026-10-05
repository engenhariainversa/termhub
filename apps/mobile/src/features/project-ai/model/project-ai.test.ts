import { setLocale } from '@/i18n';
import type { TProjectAiOption } from '@/services/api/contract';
import { accountLabel, addAccount, canSave, draftFrom, modelError, modelValid, modelWarning, moveAccount, payload, PROJECT_AI_MSG, providersOf, removeAccount, setModel } from './project-ai';

const AVAILABLE: TProjectAiOption[] = [
  { id: 'a1', label: 'Pessoal', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: true },
  { id: 'a2', label: 'Trabalho', provider: 'claude', machine_id: 'm1', machine_name: 'jarvis', default: false },
  { id: 'a3', label: 'Codex', provider: 'chatgpt', machine_id: 'm2', machine_name: 'hulk', default: false },
];
const NONE = { claude: null, chatgpt: null };

describe('accountLabel', () => {
  it('names the account, its default login, its provider and its machine', () => {
    expect(accountLabel(AVAILABLE[0]!)).toBe('Pessoal (login padrão) · Claude · jarvis');
    expect(accountLabel(AVAILABLE[2]!)).toBe('Codex · Codex · hulk');
  });

  it('in English', () => {
    setLocale('en');
    try {
      expect(accountLabel(AVAILABLE[0]!)).toBe('Pessoal (default login) · Claude · jarvis');
      expect(modelError({ choice: 'other', other: 'opus 4' })).toBe('Use only letters, numbers, dots, hyphens, colons or brackets.');
    } finally {
      setLocale(null);
    }
  });
});

describe('providersOf', () => {
  it('lists the providers that have an account, Claude first', () => {
    expect(providersOf([AVAILABLE[2]!, AVAILABLE[0]!])).toEqual(['claude', 'chatgpt']);
    expect(providersOf([AVAILABLE[2]!])).toEqual(['chatgpt']);
    expect(providersOf([])).toEqual([]);
  });
});

describe('the accounts', () => {
  const draft = draftFrom({ accounts: ['a1', 'a2'], models: NONE }, AVAILABLE);

  it('moves an account up and down, and never past either end', () => {
    expect(moveAccount(draft, 'a2', -1).accounts).toEqual(['a2', 'a1']);
    expect(moveAccount(draft, 'a1', 1).accounts).toEqual(['a2', 'a1']);
    expect(moveAccount(draft, 'a1', -1)).toBe(draft);
    expect(moveAccount(draft, 'a2', 1)).toBe(draft);
  });

  it('adds an account last, once, and removes it', () => {
    const added = addAccount(draft, 'a3');
    expect(added.accounts).toEqual(['a1', 'a2', 'a3']);
    expect(addAccount(added, 'a3')).toBe(added);
    expect(removeAccount(added, 'a1').accounts).toEqual(['a2', 'a3']);
  });

  it('leaves out an account the project can no longer list, and never saves an unknown id', () => {
    const withGone = draftFrom({ accounts: ['gone', 'a2', 'a2'], models: NONE }, AVAILABLE);
    expect(withGone.accounts).toEqual(['a2']);
    expect(payload({ ...draft, accounts: ['a1', 'nope', 'a3'] }, AVAILABLE).accounts).toEqual(['a1', 'a3']);
  });
});

describe('the model', () => {
  it('reads null as the CLI default, a Claude alias as itself, and anything else as a free id', () => {
    const draft = draftFrom({ accounts: [], models: { claude: 'sonnet', chatgpt: 'gpt-5' } }, AVAILABLE);
    expect(draft.models.claude).toEqual({ choice: 'sonnet', other: '' });
    expect(draft.models.chatgpt).toEqual({ choice: 'other', other: 'gpt-5' });
    expect(draftFrom({ accounts: [], models: { claude: 'claude-opus-4-1', chatgpt: null } }, AVAILABLE).models).toEqual({ claude: { choice: 'other', other: 'claude-opus-4-1' }, chatgpt: { choice: 'default', other: '' } });
  });

  it('refuses a free id outside the server rule, and says so once something is typed', () => {
    expect(modelValid({ choice: 'other', other: 'claude-opus-4[1m]' })).toBe(true);
    expect(modelValid({ choice: 'other', other: 'opus 4' })).toBe(false);
    expect(modelValid({ choice: 'other', other: '' })).toBe(false);
    expect(modelValid({ choice: 'other', other: '-x' })).toBe(false);
    expect(modelError({ choice: 'other', other: 'opus 4' })).toBe(PROJECT_AI_MSG.invalidModel);
    expect(modelError({ choice: 'other', other: '' })).toBeNull();
    expect(modelError({ choice: 'default', other: 'opus 4' })).toBeNull();
  });

  it('warns about a free Claude id that is not an alias, not about an alias nor a Codex id', () => {
    expect(modelWarning('claude', { choice: 'other', other: 'claude-opus-4-1' })).toBe(PROJECT_AI_MSG.freeIdWarning);
    expect(modelWarning('claude', { choice: 'other', other: 'opus' })).toBeNull();
    expect(modelWarning('claude', { choice: 'opus', other: '' })).toBeNull();
    expect(modelWarning('claude', { choice: 'other', other: 'opus 4' })).toBeNull();
    expect(modelWarning('chatgpt', { choice: 'other', other: 'gpt-5' })).toBeNull();
  });

  it('saves the choice: null for the default, the alias, or the trimmed free id', () => {
    let draft = draftFrom({ accounts: [], models: NONE }, AVAILABLE);
    draft = setModel(draft, 'claude', { choice: 'haiku' });
    draft = setModel(draft, 'chatgpt', { choice: 'other', other: ' gpt-5 ' });
    expect(payload(draft, AVAILABLE).models).toEqual({ claude: 'haiku', chatgpt: 'gpt-5' });
    expect(payload(setModel(draft, 'claude', { choice: 'default' }), AVAILABLE).models.claude).toBeNull();
  });
});

describe('canSave', () => {
  const saved = { accounts: ['a1'], models: { claude: 'opus', chatgpt: null } };
  const draft = draftFrom(saved, AVAILABLE);

  it('is off while nothing changed, on once something did', () => {
    expect(canSave(draft, saved, AVAILABLE)).toBe(false);
    expect(canSave(addAccount(draft, 'a2'), saved, AVAILABLE)).toBe(true);
    expect(canSave(setModel(draft, 'claude', { choice: 'sonnet' }), saved, AVAILABLE)).toBe(true);
  });

  it('is off while a model is invalid', () => {
    expect(canSave(setModel(addAccount(draft, 'a2'), 'claude', { choice: 'other', other: 'opus 4' }), saved, AVAILABLE)).toBe(false);
  });

  it('does not count a saved account the project can no longer list as a change', () => {
    const withGone = { ...saved, accounts: ['gone', 'a1'] };
    expect(canSave(draftFrom(withGone, AVAILABLE), withGone, AVAILABLE)).toBe(false);
  });
});
