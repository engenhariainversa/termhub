// "Contas e modelo do projeto" (spec 2026-09-30 project AI accounts §8): the pure editing rules of the
// screen — the accounts in priority order, the model choice per provider, what is saved. The web's
// setup card follows the same rules (`apps/web`'s SetupForm); the server validates what it saves.
import { t } from '@/i18n';
import { CLAUDE_MODEL_ALIASES, type TProjectAi, type TProjectAiOption } from '@/services/api/contract';

export type Provider = TProjectAiOption['provider'];
export type ClaudeAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** One provider's model as the screen edits it: the CLI's default (no model), an alias (Claude only), or a free id. */
export interface ModelDraft {
  choice: 'default' | ClaudeAlias | 'other';
  /** The free id's text, kept while another choice is picked so switching back does not lose it. */
  other: string;
}

export interface ProjectAiDraft {
  /** Account ids, priority order: only accounts the project may list. */
  accounts: string[];
  models: Record<Provider, ModelDraft>;
}

/** The server's model rule (`apps/server`'s setup schema): a CLI model id or alias. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}$/;

export const PROVIDERS: readonly Provider[] = ['claude', 'chatgpt'];
/** The Claude aliases every CLI version resolves itself, in the order the screen offers them. */
export const CLAUDE_ALIASES: readonly ClaudeAlias[] = CLAUDE_MODEL_ALIASES;
export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', chatgpt: 'Codex' };

/** The screen's copy: each property is a getter, read in the language the app shows at that moment. */
export const PROJECT_AI_MSG = {
  get title() { return t('Contas e modelo do projeto'); },
  get empty() { return t('Sem contas escolhidas, cada início de agente pede a conta, como hoje.'); },
  get invalidModel() { return t('Use só letras, números, ponto, hífen, dois-pontos ou colchetes.'); },
  get freeIdWarning() { return t('Um CLI mais antigo numa máquina pode não reconhecer este id. Um apelido (opus, sonnet, haiku) vale em qualquer versão.'); },
  get saved() { return t('Contas e modelo salvos.'); },
  get network() { return t('Não foi possível falar com o servidor. Tente de novo.'); },
};

const isAlias = (value: string): value is ClaudeAlias => (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value);

/** "Pessoal (login padrão) · Claude · jarvis". */
export function accountLabel(o: TProjectAiOption): string {
  const label = o.default ? t('{{label}} (login padrão)', { label: o.label }) : o.label;
  return `${label} · ${PROVIDER_LABEL[o.provider]} · ${o.machine_name}`;
}

/** The providers that have an account the project may list, in a fixed order: one model choice each. */
export function providersOf(available: readonly TProjectAiOption[]): Provider[] {
  return PROVIDERS.filter((p) => available.some((o) => o.provider === p));
}

function modelDraft(provider: Provider, value: string | null): ModelDraft {
  if (value === null || value === '') return { choice: 'default', other: '' };
  if (provider === 'claude' && isAlias(value)) return { choice: value, other: '' };
  return { choice: 'other', other: value };
}

/** The saved block as the screen edits it. An account the project can no longer list (its machine was
 * unlinked, the account removed) is left out: it could not be saved back. */
export function draftFrom(ai: TProjectAi, available: readonly TProjectAiOption[]): ProjectAiDraft {
  const known = new Set(available.map((o) => o.id));
  return {
    accounts: ai.accounts.filter((id, i) => known.has(id) && ai.accounts.indexOf(id) === i),
    models: { claude: modelDraft('claude', ai.models.claude), chatgpt: modelDraft('chatgpt', ai.models.chatgpt) },
  };
}

/** The model a choice saves: null for the CLI's default. */
export function modelValue(m: ModelDraft): string | null {
  if (m.choice === 'default') return null;
  return m.choice === 'other' ? m.other.trim() : m.choice;
}

export function modelValid(m: ModelDraft): boolean {
  return m.choice !== 'other' || MODEL_RE.test(m.other.trim());
}

/** What the free id's field says under it: the format error once something is typed, else nothing. */
export function modelError(m: ModelDraft): string | null {
  return m.choice === 'other' && m.other.trim() !== '' && !MODEL_RE.test(m.other.trim()) ? PROJECT_AI_MSG.invalidModel : null;
}

/** A valid free Claude id that is not an alias: an older CLI may not know it. */
export function modelWarning(provider: Provider, m: ModelDraft): string | null {
  if (provider !== 'claude' || m.choice !== 'other') return null;
  const value = m.other.trim();
  return MODEL_RE.test(value) && !isAlias(value) ? PROJECT_AI_MSG.freeIdWarning : null;
}

/** The PUT body's `ai`: the listed accounts only (never an id the project cannot list), and each model. */
export function payload(draft: ProjectAiDraft, available: readonly TProjectAiOption[]): TProjectAi {
  const known = new Set(available.map((o) => o.id));
  return {
    accounts: draft.accounts.filter((id) => known.has(id)),
    models: { claude: modelValue(draft.models.claude), chatgpt: modelValue(draft.models.chatgpt) },
  };
}

export function sameAi(a: TProjectAi, b: TProjectAi): boolean {
  return a.accounts.length === b.accounts.length && a.accounts.every((id, i) => id === b.accounts[i]) && a.models.claude === b.models.claude && a.models.chatgpt === b.models.chatgpt;
}

/** Whether "Salvar" can go: something changed and every model is valid. */
export function canSave(draft: ProjectAiDraft, saved: TProjectAi, available: readonly TProjectAiOption[]): boolean {
  if (!PROVIDERS.every((p) => modelValid(draft.models[p]))) return false;
  return !sameAi(payload(draft, available), payload(draftFrom(saved, available), available));
}

/** `id` one place up (`delta` -1) or down (+1); the same draft at either end. */
export function moveAccount(draft: ProjectAiDraft, id: string, delta: -1 | 1): ProjectAiDraft {
  const i = draft.accounts.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= draft.accounts.length) return draft;
  const accounts = [...draft.accounts];
  [accounts[i], accounts[j]] = [accounts[j]!, accounts[i]!];
  return { ...draft, accounts };
}

/** Includes `id`, last in priority. */
export function addAccount(draft: ProjectAiDraft, id: string): ProjectAiDraft {
  return draft.accounts.includes(id) ? draft : { ...draft, accounts: [...draft.accounts, id] };
}

export function removeAccount(draft: ProjectAiDraft, id: string): ProjectAiDraft {
  return draft.accounts.includes(id) ? { ...draft, accounts: draft.accounts.filter((a) => a !== id) } : draft;
}

export function setModel(draft: ProjectAiDraft, provider: Provider, patch: Partial<ModelDraft>): ProjectAiDraft {
  return { ...draft, models: { ...draft.models, [provider]: { ...draft.models[provider], ...patch } } };
}
