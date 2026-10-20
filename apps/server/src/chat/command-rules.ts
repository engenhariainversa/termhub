/**
 * The command allow list of `run_command` (TER-1081): which commands the chat's concierge may type in a
 * shell tab without a card. Pure: parsing, the "never" list, the read-only default list and rule
 * matching. The gate (`commandRuleCovering` in gate-runtime.ts) adds the tab, the rules in force and the
 * budgets; the decision route and the MCP tool use the same functions, so a rule is only ever created
 * for what the gate will honour.
 *
 * The parser is deliberately narrower than any shell: a command is covered only when it is one simple
 * command — words, quotes, nothing the shell would expand or chain. Anything it does not understand is
 * not an error, it is "ask": the person sees a card, as before this list existed.
 */

/** `exact`: the command's words are the rule's words. `prefix`: the rule's words start the command. */
export const COMMAND_RULE_MATCHES = ['exact', 'prefix'] as const;
export type CommandRuleMatch = (typeof COMMAND_RULE_MATCHES)[number];
export const isCommandRuleMatch = (v: unknown): v is CommandRuleMatch => (COMMAND_RULE_MATCHES as readonly string[]).includes(v as string);

export type ParsedCommand = { ok: true; words: string[] } | { ok: false; reason: CommandRefusal };

/** Why a command is outside every rule. Stable codes, for tests and for the MCP tool's error. */
export type CommandRefusal =
  | 'empty'
  | 'control_char'
  | 'operator'
  | 'expansion'
  | 'glob'
  | 'history'
  | 'escape'
  | 'unterminated_quote'
  | 'assignment'
  | 'never_program'
  | 'destructive_git'
  | 'find_action'
  | 'secret';

// Every C0 control character, DEL, and the Unicode line breaks a terminal may treat as one: a newline is
// a second command, and the rest edit the line being typed (Ctrl-U wipes it), so none of them is "text".
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** Unquoted characters that chain, redirect, substitute or background: `;`, `&&`, `|`, `<`, `>`, `( )`. */
const OPERATORS = new Set([';', '&', '|', '<', '>', '(', ')']);
/** Unquoted characters the shell expands: variables and substitution, braces, tildes, comments, zsh's `^`. */
const EXPANSIONS = new Set(['$', '`', '{', '}', '~', '#', '^']);
const GLOBS = new Set(['*', '?', '[', ']']);

/**
 * Splits a command into its words the way a POSIX shell would, or refuses it. Single quotes are literal;
 * double quotes are literal except that `$`, a backtick or a backslash inside them is refused (they would
 * expand or escape); `!` is refused anywhere, quoted or not, since an interactive bash expands history
 * even inside double quotes. Outside quotes, any operator, expansion, glob or backslash is refused.
 */
export function parseCommand(command: string): ParsedCommand {
  if (CONTROL.test(command)) return { ok: false, reason: 'control_char' };
  if (command.includes('!')) return { ok: false, reason: 'history' };
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of command) {
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '$' || ch === '`') return { ok: false, reason: 'expansion' };
      else if (ch === '\\') return { ok: false, reason: 'escape' };
      else word += ch;
      continue;
    }
    if (ch === ' ') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (OPERATORS.has(ch)) return { ok: false, reason: 'operator' };
    // A tilde expands only at the start of a word or after `=`/`:` (`HEAD~1` is plain text).
    if (ch === '~' && inWord && !word.endsWith('=') && !word.endsWith(':')) {
      word += ch;
      continue;
    }
    if (EXPANSIONS.has(ch)) return { ok: false, reason: 'expansion' };
    if (GLOBS.has(ch)) return { ok: false, reason: 'glob' };
    if (ch === '\\') return { ok: false, reason: 'escape' };
    word += ch;
    inWord = true;
  }
  if (quote) return { ok: false, reason: 'unterminated_quote' };
  if (inWord) words.push(word);
  if (words.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, words };
}

/** How a list of words reads back as a command: plain words as they are, anything else single-quoted. */
export function formatWords(words: readonly string[]): string {
  return words.map((w) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replaceAll("'", `'"'"'`)}'`)).join(' ');
}

/** The program a command runs, by its base name: `/bin/rm` is `rm`. */
const programOf = (words: readonly string[]): string => words[0]!.split('/').pop() ?? '';

/** Programs no rule ever covers: privilege, deletion, killing, power, raw disks, and the shell's own
 * builtins that run or print anything (eval, source, the environment). */
const NEVER_PROGRAMS = new Set([
  'sudo', 'su', 'doas', 'pkexec', 'run0',
  'rm', 'rmdir', 'shred', 'unlink', 'srm',
  'kill', 'pkill', 'killall', 'xkill',
  'shutdown', 'reboot', 'poweroff', 'halt', 'init',
  'dd', 'mkfs', 'fdisk', 'parted', 'wipefs', 'diskutil',
  'eval', 'exec', 'source', '.',
  'env', 'printenv', 'export', 'set', 'unset', 'alias',
  'security', 'keychain',
]);

/** Programs that run another command given in their arguments (a shell, ssh, xargs, a timer). A prefix
 * rule never covers them: `ssh hulk` as a prefix would cover `ssh hulk <anything>`. An exact rule can,
 * since then the whole command line is what the person saw and allowed. */
const WRAPPER_PROGRAMS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'nu', 'pwsh',
  'ssh', 'mosh', 'xargs', 'parallel', 'nohup', 'time', 'timeout', 'watch', 'nice', 'ionice', 'stdbuf', 'script',
  'command', 'builtin', 'chroot', 'flock', 'npx', 'pnpx', 'bunx',
]);

const isShortCluster = (w: string, letter: string): boolean => /^-[A-Za-z]+$/.test(w) && w.includes(letter);

/** `git push --force` (any spelling of it, a forced or deleting refspec), `git reset --hard`, `git clean`,
 * and git's own way of running another program (`-c`, `--config-env`, `--exec-path`). */
function destructiveGit(words: readonly string[]): boolean {
  const args = words.slice(1);
  if (args.some((w) => w === '-c' || w.startsWith('--config-env') || w.startsWith('--exec-path'))) return true;
  const sub = args.find((w) => !w.startsWith('-'));
  if (sub === 'clean') return true;
  if (sub === 'reset' && args.includes('--hard')) return true;
  if (sub === 'push') {
    return args.some(
      (w) =>
        w === '--force' || w.startsWith('--force-with-lease') || w === '--force-if-includes' || w === '--mirror' || w === '--delete' || w === '--prune' ||
        isShortCluster(w, 'f') || isShortCluster(w, 'd') || w.startsWith('+') || (w.startsWith(':') && w.length > 1),
    );
  }
  return false;
}

const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);

/** A path segment that names a secret: env files, keys, credentials, tokens, the ssh/gpg/cloud dirs. */
const SECRET_SEGMENT =
  /^(\.env(\..*)?|.*\.env|\.ssh|\.gnupg|\.aws|\.kube|\.azure|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.docker|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg)|shadow|gshadow|environ|.*credential.*|.*secret.*|.*token.*|.*passw(or)?d.*)$/i;

/** Whether any word refers to a secret: checked on each path segment, on the value of `--opt=value` and on the path of `rev:path`. */
function touchesSecret(words: readonly string[]): boolean {
  return words.some((w) => w.split(/[/=:]/).some((seg) => seg.length > 0 && SECRET_SEGMENT.test(seg)));
}

/** Why no rule may cover these words, or null. Checked before any rule and before the default list. */
export function neverReason(words: readonly string[]): CommandRefusal | null {
  // `FOO=bar git status`: an assignment before the program (GIT_SSH_COMMAND, PAGER, LD_PRELOAD…) runs code.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return 'assignment';
  const program = programOf(words);
  if (NEVER_PROGRAMS.has(program) || program.startsWith('mkfs')) return 'never_program';
  if (program === 'git' && destructiveGit(words)) return 'destructive_git';
  if (program === 'find' && words.some((w) => FIND_ACTIONS.has(w))) return 'find_action';
  if (touchesSecret(words)) return 'secret';
  return null;
}

/** Parses a command and applies the "never" list: the words a rule may be judged on, or why not. */
export function ruleEligible(command: string): ParsedCommand {
  const parsed = parseCommand(command);
  if (!parsed.ok) return parsed;
  const never = neverReason(parsed.words);
  return never ? { ok: false, reason: never } : parsed;
}

export interface CommandRuleShape {
  words: readonly string[];
  match: CommandRuleMatch;
}

/** Whether a rule covers already-eligible words. A prefix rule matches whole words (`git s` never covers
 * `git status`) and never covers a wrapper program (`WRAPPER_PROGRAMS`). */
export function ruleMatches(rule: CommandRuleShape, words: readonly string[]): boolean {
  if (rule.words.length === 0) return false;
  if (rule.match === 'exact') return rule.words.length === words.length && rule.words.every((w, i) => w === words[i]);
  if (WRAPPER_PROGRAMS.has(programOf(words))) return false;
  return rule.words.length <= words.length && rule.words.every((w, i) => w === words[i]);
}

/** Whether these words may be stored as a rule of this kind: eligible on their own, and a prefix never
 * of a wrapper program. Used by the decision route and the MCP tool before anything is written. */
export function ruleWordsAllowed(words: readonly string[], match: CommandRuleMatch): CommandRefusal | 'wrapper_prefix' | null {
  if (words.length === 0) return 'empty';
  const never = neverReason(words);
  if (never) return never;
  if (match === 'prefix' && WRAPPER_PROGRAMS.has(programOf(words))) return 'wrapper_prefix';
  return null;
}

/** How many leading words name the command for a program with subcommands (`git push`, `gh pr checks`). */
const SUBCOMMAND_DEPTH: Record<string, number> = {
  git: 2, gh: 3, glab: 3, npm: 2, pnpm: 2, yarn: 2, bun: 2, docker: 2, podman: 2, kubectl: 2, systemctl: 2,
  brew: 2, cargo: 2, go: 2, eas: 2, make: 2, terraform: 2, apt: 2, flyctl: 2, fly: 2, heroku: 2, aws: 3, gcloud: 3,
};
/** A second word that takes one more: `npm run build`, `docker compose up`. */
const DEEPER: Record<string, ReadonlySet<string>> = {
  npm: new Set(['run', 'run-script']), pnpm: new Set(['run']), yarn: new Set(['run']), bun: new Set(['run']),
  docker: new Set(['compose']), podman: new Set(['compose']),
};
const PLAIN_WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The prefix "Permitir sempre comandos que começam com «…»" offers for a command: the program, and for a
 * program with subcommands the subcommand words too (`git push origin main` → `git push`; `gh pr checks
 * 12` → `gh pr checks`). Null when there is no useful prefix: a wrapper program, a program named by
 * path, or a prefix that would be the whole command (then only "este comando" is offered).
 */
export function suggestPrefix(words: readonly string[]): string[] | null {
  const first = words[0]!;
  if (first.includes('/') || WRAPPER_PROGRAMS.has(first) || !PLAIN_WORD.test(first)) return null;
  let depth = SUBCOMMAND_DEPTH[first] ?? 1;
  if (DEEPER[first]?.has(words[1] ?? '')) depth += 1;
  const prefix = [first];
  for (const w of words.slice(1, depth)) {
    if (!PLAIN_WORD.test(w)) break;
    prefix.push(w);
  }
  return prefix.length < words.length ? prefix : null;
}

/** What a pending `run_command` card offers, computed from its command alone: the normalized command
 * ("este comando") and the prefix, or null when no rule could cover it. The server still checks the tab. */
export function commandRuleOffer(command: unknown): { exact: string; prefix: string | null } | null {
  if (typeof command !== 'string') return null;
  const parsed = ruleEligible(command);
  if (!parsed.ok) return null;
  const prefix = suggestPrefix(parsed.words);
  return { exact: formatWords(parsed.words), prefix: prefix ? formatWords(prefix) : null };
}

// ---------------------------------------------------------------------------------------------------
// The read-only default list ("Comandos só de leitura", on for every user unless restricted).

const GIT_READ = new Set(['status', 'log', 'diff', 'show']);
const GIT_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current', '--no-color', '--color']);
const GH_READ = new Set(['pr view', 'pr checks', 'pr list', 'run view', 'run list']);
const ANY_ARGS = new Set(['ls', 'pwd', 'df', 'du', 'ps', 'uptime', 'which', 'whoami', 'uname']);
const PROJECT_FILE_READERS = new Set(['cat', 'head', 'tail']);
const VERSION_PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** A relative path inside the tab's directory: not absolute, no `..` segment. */
const projectRelative = (w: string): boolean => !w.startsWith('/') && !w.split('/').includes('..');

/**
 * Whether eligible words are one of the read-only commands every user gets without a card: `git
 * status/log/diff/show/branch` (no `--output`, `branch` with listing flags only), `gh pr view/checks/list`,
 * `gh run view/list`, `ls`, `pwd`, `df`, `du`, `ps`, `uptime`, `which`, `whoami`, `uname`, `cat`/`head`/
 * `tail` of files under the tab's directory, and `<program> --version`. Exact program names: `/bin/ls` is
 * not `ls` here.
 */
export function isReadOnlyCommand(words: readonly string[]): boolean {
  const [program, ...args] = words;
  if (!program) return false;
  if (args.length === 1 && args[0] === '--version') return VERSION_PROGRAM.test(program) && !WRAPPER_PROGRAMS.has(program);
  if (ANY_ARGS.has(program)) return true;
  if (PROJECT_FILE_READERS.has(program)) return args.every((a) => a.startsWith('-') || projectRelative(a));
  if (program === 'git') {
    const [sub, ...rest] = args;
    if (sub && GIT_READ.has(sub)) return !rest.some((a) => a.startsWith('--output') || a === '-o');
    if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.has(a));
    return false;
  }
  if (program === 'gh') return args.length >= 2 && GH_READ.has(`${args[0]} ${args[1]}`);
  return false;
}
