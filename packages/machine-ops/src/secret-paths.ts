/**
 * Paths a file shared in the chat (TER-1086) may never come from, whoever asks: keys, credentials and
 * env files, keychains and the config dirs of the AI CLIs and of the tools that keep tokens. One rule for
 * both sides: the server refuses the path as asked before anything reaches the machine, and the agent
 * checks it again on the path as asked and on the file it resolves to (links followed).
 *
 * Pure: compares path segments, lowercase, and never touches the disk.
 */

/** Folders (any segment) whose contents are secret: SSH, GPG, cloud and container credentials, the
 *  AI CLIs' config dirs (`.claude`, `.claude_<account>`, `.codex`, `.gemini`, …), the agent's own. */
const SECRET_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.config', '.local', '.termhub',
  '.claude', '.codex', '.gemini', '.cursor', '.antigravity', '.password-store', 'keychains',
];
/** A segment starting with one of these is one of the dirs above under another name (`.claude_work`). */
const SECRET_DIR_PREFIXES = ['.claude', '.codex', '.gemini'];

/** File names that hold secrets, whatever their folder. */
const SECRET_NAMES = [
  /^\.?env(\..*)?$/, // .env, .env.local, env.production
  /\.env$/,
  /^\.?credentials(\..*)?$/, // .credentials.json (Claude Code), credentials, credentials.json
  /credential/,
  /secret/,
  /^\.?netrc$/,
  /^\.?npmrc$/,
  /^\.?pgpass$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /\.(pem|key|p12|pfx|kdbx|keychain|keychain-db|ovpn|jks|keystore)$/,
  /^auth\.json$/,
  /^token(s)?(\..*)?$/,
  /service[-_]?account/,
];

/** Splits an absolute (or `~/`) path into its segments, lowercase, `.` and empty segments dropped. */
const segmentsOf = (p: string): string[] =>
  p
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '~')
    .map((s) => s.toLowerCase());

/** Whether `path` names a secret file or sits under a secret folder. */
export function isSecretPath(path: string): boolean {
  const segs = segmentsOf(path);
  if (segs.length === 0) return false;
  const dirs = segs.slice(0, -1);
  const name = segs[segs.length - 1]!;
  if (segs.some((s) => SECRET_DIRS.includes(s) || SECRET_DIR_PREFIXES.some((p) => s.startsWith(p)))) return true;
  if (dirs.includes('library') && segs.includes('keychains')) return true;
  return SECRET_NAMES.some((re) => re.test(name));
}
