// The Claude Code model list, in one place (TER-1097): the web's setup card, the app's screen, the server's
// validation and the MCP tool descriptions all read it here, so the next model enters everywhere at once.
// Kept free of zod on purpose: the web imports this module alone (`@termhub/mobile-api/models`) and must
// not pull the schemas into its bundle.

/**
 * The aliases the Claude CLI resolves itself to the newest model of each family, in the order the screens
 * offer them (the CLI's own `--model` help order). `fable` arrived with Claude Fable 5 in Claude Code
 * 2.1.170 (changelog) and is confirmed on 2.1.305, which runs `--model fable` on `claude-fable-5-1`;
 * `opus`, `sonnet` and `haiku` are older than any CLI still in use.
 */
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

/** "fable, opus, sonnet, haiku": the list as messages quote it. */
export const CLAUDE_MODEL_ALIAS_LIST = CLAUDE_MODEL_ALIASES.join(', ');

/** The placeholder of the free-id field per CLI: a full id of the newest model. */
export const MODEL_ID_EXAMPLE = { claude: 'claude-fable-5-1', chatgpt: 'gpt-5-codex' } as const;

/**
 * A model id as the CLI takes it after `--model`/`-m` (TER-589): an alias (`opus`, `sonnet[1m]`) or a full
 * id (`claude-opus-5-5`, `gpt-5-codex`). Nothing the shell could read is allowed, even though the line
 * quotes it anyway; nor a leading `-`, which the CLI would read as another option.
 *
 * Every `[`, `]` and `-` inside the class is escaped (TER-626): this pattern reaches the start_agent
 * tool's JSON schema, and a validator whose regex engine nests classes (the Claude API's) read the bare
 * `[` as a class that never closes, refused the schema, and every session loading the MCP died with it.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]\-]{0,99}$/;

const ALIAS_RE = new RegExp(`^(${CLAUDE_MODEL_ALIASES.join('|')})(\\[[a-z0-9]+\\])?$`);

/**
 * Whether the model is an alias the Claude CLI resolves itself (owner decision 2026-09-30), with or
 * without a context suffix (`sonnet[1m]`): a full id may be unknown to an older CLI, which is what broke
 * the concierge container on 2026-09-30. `opusplan`-style words and full ids are not aliases.
 */
export function isClaudeModelAlias(model: string): boolean {
  return ALIAS_RE.test(model);
}
