/**
 * Claude Code's auto mode dialogs in manual tabs (TER-1210). In auto mode, Claude Code's classifier answers
 * almost every tool call itself; what it cannot check (a `sh -c` script that runs `rm`, a command its
 * parser gives up on) it asks the person, with a countdown: "Claude Code will automatically block this
 * request in 1:56, to avoid holding up an unattended session". Nobody is looking at an unattended tab, so
 * the request was refused by the timeout even when the card reached the chat.
 *
 * For a person on "liberado por padrão" the server now answers that dialog "Yes" unless the command hits
 * the hard lock below or one of the person's blocks (the maintainer's decision, 2026-11-24: "only the hard
 * lock"). This file is the pure half: reading the dialog and its command off a plain capture of the
 * screen, and judging the command. `auto-mode-answer.ts` is the runtime half.
 *
 * The command is read from the screen, not from the hook: the hook script forwards the tool's name only
 * (spec 2026-09-25 tab questions §4.1) unless the machine opted in to hints, and even then only a filtered
 * excerpt. The dialog prints the whole command in its box, wrapped at the pane's width.
 */
import { SECRET_PATH } from '../automation/secret-paths.js';
import { blockFor, type BlockShape } from './open-permissions.js';

/** The countdown line only auto mode draws (captured on Claude Code 2.1.331; the manual mode dialog of the
 *  same command has none: fixtures/permission-dialogs/claude-manual-unchecked.txt). Compared squashed, so
 *  a narrow pane that wraps it still matches. */
const COUNTDOWN = 'Claude Code will automatically block this request in';

/** Claude Code draws its dialog under a box rule, and a Bash command's box between two dashed rules. */
const RULE = /^\s*[─━]{10,}\s*$/;
const DASHED = /^\s*╌{10,}\s*$/;
/** A row of the command's box: `│ ` then the command's text. */
const BOX_ROW = /^\s*│ ?(.*)$/;
/** What Claude Code writes when the box does not hold the whole command. */
const TRUNCATED = /^\s*…|…\s*$|\+\s*\d+\s+(more\s+)?lines?\b|\bmore lines\)/;

const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The command of the auto mode Bash dialog on screen, as the readings it may stand for, or null when the
 * screen does not show exactly that: the main thread's "Bash command" dialog (no subagent's), a box whose
 * rows all start with `│`, nothing cut short, and the auto mode countdown below it.
 *
 * A wrapped row may have been cut at a space (the space is gone) or inside a word, and the capture cannot
 * tell which. So both readings come back, rows joined with nothing and with a space; the caller judges
 * both and approves only when both pass. A dangerous word split over a row break shows whole in one of them.
 */
export function autoModeBashCommand(screen: string): string[] | null {
  const lines = screen.split('\n');
  let rule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RULE.test(lines[i]!)) {
      rule = i;
      break;
    }
  }
  if (rule < 0) return null;
  const rest = lines.slice(rule + 1).filter((l) => l.trim() !== '');
  if ((rest[0] ?? '').trim() !== 'Bash command') return null;
  const open = rest.findIndex((l) => DASHED.test(l));
  if (open < 0) return null;
  const close = rest.findIndex((l, i) => i > open && DASHED.test(l));
  if (close < 0 || close === open + 1) return null;
  const rows: string[] = [];
  for (const line of rest.slice(open + 1, close)) {
    const m = BOX_ROW.exec(line);
    if (!m) return null;
    const row = m[1]!.replace(/\s+$/, '');
    if (TRUNCATED.test(row)) return null;
    rows.push(row);
  }
  if (!squash(rest.slice(close + 1).join(' ')).includes(squash(COUNTDOWN))) return null;
  const glued = rows.join('');
  const spaced = rows.join(' ');
  return glued === spaced ? [glued] : [glued, spaced];
}

/** Why a command is not approved alone: a stable code for the logs (never the command itself). */
export type HardLockReason = 'unreadable' | 'merge' | 'push' | 'publish' | 'recursive_rm' | 'container' | 'privilege' | 'disk' | 'git_destructive' | 'git_config' | 'secret' | 'blocked';

/** How deep a script inside a script is read (`sh -c "bash -c '…'"`); deeper is unreadable. */
const MAX_DEPTH = 4;

/**
 * The simple commands a shell line runs, as their words with the quotes taken off, or null when it cannot
 * be read with confidence: an unterminated quote, a here-document, a substitution with no end, too deep.
 * Narrower than a shell on purpose; anything it does not understand is "unreadable", and the card stays
 * for the person. Every list, pipe, redirection, subshell and `$( … )` / backtick substitution splits a
 * command; a substitution's own commands are read too (also inside double quotes).
 */
export function simpleCommands(script: string, depth = 0): string[][] | null {
  if (depth > MAX_DEPTH) return null;
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  const nested = (body: string): boolean => {
    const inner = simpleCommands(body, depth + 1);
    if (!inner) return false;
    commands.push(...inner);
    return true;
  };
  /** The end of a `$(` opened at `start` (the index of its `(`), counting parens outside quotes; -1 if none. */
  const closeParen = (start: number): number => {
    let level = 0;
    let q: string | null = null;
    for (let j = start; j < script.length; j++) {
      const c = script[j]!;
      if (q) {
        if (c === '\\' && q === '"') j++;
        else if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"') q = c;
      else if (c === '\\') j++;
      else if (c === '(') level++;
      else if (c === ')' && --level === 0) return j;
    }
    return -1;
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return null;
      word += script.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        const c = script[j]!;
        if (c === '\\') {
          word += script[j + 1] ?? '';
          j++;
        } else if (c === '$' && script[j + 1] === '(') {
          const end = closeParen(j + 1);
          if (end < 0 || !nested(script.slice(j + 2, end))) return null;
          word += script.slice(j, end + 1);
          j = end;
        } else if (c === '`') {
          const end = script.indexOf('`', j + 1);
          if (end < 0 || !nested(script.slice(j + 1, end))) return null;
          j = end;
        } else word += c;
      }
      if (j >= script.length) return null;
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      if (script[i + 1] !== '\n') {
        word += script[i + 1] ?? '';
        inWord = true;
      }
      i++;
      continue;
    }
    if (ch === '$' && script[i + 1] === '(') {
      const end = closeParen(i + 1);
      if (end < 0 || !nested(script.slice(i + 2, end))) return null;
      word += '$()';
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = script.indexOf('`', i + 1);
      if (end < 0 || !nested(script.slice(i + 1, end))) return null;
      word += '$()';
      inWord = true;
      i = end;
      continue;
    }
    if (ch === '<' && script[i + 1] === '<' && script[i + 2] !== '<') return null; // a here-document
    if (ch === '#' && !inWord) {
      const nl = script.indexOf('\n', i);
      i = nl < 0 ? script.length : nl - 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      endWord();
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '\r' || ch === '(' || ch === ')' || ch === '<' || ch === '>') {
      endCommand();
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand();
  // A script handed to a shell (`sh -c '…'`, `docker run … bash -lc '…'`, `eval '…'`) is read as commands;
  // so is any other word with a space or an operator in it (`ssh host 'rm -rf x'`, `watch "…"`), where a
  // failed read falls back to its bare words, the safe direction for the checks below.
  const extra: string[][] = [];
  for (const cmd of commands) {
    for (let k = 0; k < cmd.length; k++) {
      const w = cmd[k]!;
      const prev = cmd[k - 1] ?? '';
      const script = /^-[A-Za-z]*c[A-Za-z]*$/.test(prev) || base(prev) === 'eval';
      if (!script && !/[\s;&|<>()`]|\$\(/.test(w)) continue;
      const inner = simpleCommands(w, depth + 1);
      if (inner) extra.push(...inner);
      else if (script) return null;
      else extra.push(w.split(/[\s;&|<>()`$'"]+/).filter(Boolean));
    }
  }
  return [...commands, ...extra];
}

/** A word reduced to its program name: `/usr/bin/rm` → `rm`. */
const base = (w: string): string => w.split('/').pop() ?? '';

const PRIVILEGE = new Set(['sudo', 'su', 'doas', 'pkexec', 'run0']);
const DISK = new Set(['dd', 'shred', 'wipefs', 'fdisk', 'parted', 'diskutil']);
const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl']);
const CONTAINER_REFUSED = new Set(['rm', 'rmi', 'stop', 'kill', 'prune', 'down']);
const PACKAGE_TOOLS = new Set(['npm', 'pnpm', 'yarn']);
/** git's global options that take their value in the next word (`git -C <path> push`). */
const GIT_OPTION_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix']);
/** A push that overwrites or removes what is on the remote, or reaches every ref at once, or runs a program there. */
const PUSH_REFUSED = /^--(force|mirror|all|tags|delete|prune|receive-pack|exec)(=|$)|^--force-/;

/** The git part of the hard lock, from the word after `git`: config injection, a destructive push, `reset --hard`, `clean`. */
function gitReason(args: string[]): HardLockReason | null {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a.startsWith('-c') || a.startsWith('--config-env') || a.startsWith('--exec-path')) return 'git_config';
    if (GIT_OPTION_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'push') {
    for (const a of rest) {
      if (a.startsWith('--')) {
        if (PUSH_REFUSED.test(a)) return 'push';
      } else if (a.startsWith('-')) {
        if (/[fd]/.test(a.slice(1))) return 'push';
      } else if (a.startsWith('+') || a.startsWith(':')) return 'push'; // a forced or deleting refspec
    }
    return null;
  }
  if (sub === 'reset' && rest.includes('--hard')) return 'git_destructive';
  if (sub === 'clean') return 'git_destructive';
  return null;
}

/** The hard lock on one simple command's words: read at every position, so a prefix (`env`, `npx`, `xargs`, a path) does not hide it. */
function commandReason(words: string[]): HardLockReason | null {
  for (const w of words) if (SECRET_PATH.test(w)) return 'secret';
  for (let i = 0; i < words.length; i++) {
    const t = base(words[i]!);
    const rest = words.slice(i + 1);
    if (PRIVILEGE.has(t)) return 'privilege';
    if (DISK.has(t) || t.startsWith('mkfs')) return 'disk';
    if (t === 'gh' && rest.some((r, j) => r === 'pr' && rest[j + 1] === 'merge')) return 'merge';
    if (t === 'git') {
      const reason = gitReason(rest);
      if (reason) return reason;
    }
    if (PACKAGE_TOOLS.has(t) && rest.includes('publish')) return 'publish';
    if (PACKAGE_TOOLS.has(t) && rest.some((r, j) => (r === 'run' || r === 'run-script') && (rest[j + 1] ?? '').startsWith('release'))) return 'publish';
    if (t === 'eas' || t === 'eas-cli' || t === 'fastlane') return 'publish';
    if (t === 'rm' && rest.some((r) => r === '--recursive' || /^-[a-zA-Z]*[rR]/.test(r))) return 'recursive_rm';
    if (CONTAINER_TOOLS.has(t) && rest.some((r) => CONTAINER_REFUSED.has(r))) return 'container';
  }
  return null;
}

/**
 * Why a command read off an auto mode dialog is not approved alone, or null when it may be. The hard lock:
 * `gh pr merge`; a push that forces, deletes, mirrors or sends every ref (an ordinary push of any branch
 * passes: a manual tab has no run branch to hold it to); git's config injection, `reset --hard`, `clean`;
 * publishing (`npm publish`, `npm run release*`, `eas`, `fastlane`); a recursive `rm`; removing, stopping
 * or pruning containers (this host may be production); privilege (`sudo`…); raw disks; a secret's path.
 * Then the person's blocks (`blocks`, already the effective ones): one on typing into tabs (`terminal`) or
 * on `run_command` for this project or every project; a `run_command` block with words applies to the
 * commands that start with them.
 */
export function hardLockReason(command: string, blocks: readonly BlockShape[] = [], projectId: string | null = null): HardLockReason | null {
  const commands = simpleCommands(command);
  if (!commands || commands.length === 0) return 'unreadable';
  if (blockFor(blocks, 'terminal', projectId, null)) return 'blocked';
  for (const words of commands) {
    const reason = commandReason(words);
    if (reason) return reason;
    if (blockFor(blocks, 'run_command', projectId, words.map((w, i) => (i === 0 ? base(w) : w)))) return 'blocked';
  }
  return null;
}

/**
 * The verdict on the screen as read: null when it shows the auto mode Bash dialog with a command that
 * passes `hardLockReason` in every reading, else why not (`not_auto_mode` for any other screen).
 */
export function autoModeVerdict(screen: string, blocks: readonly BlockShape[] = [], projectId: string | null = null): HardLockReason | 'not_auto_mode' | null {
  const readings = autoModeBashCommand(screen);
  if (!readings) return 'not_auto_mode';
  for (const command of readings) {
    const reason = hardLockReason(command, blocks, projectId);
    if (reason) return reason;
  }
  return null;
}
