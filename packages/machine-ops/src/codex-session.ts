/**
 * A Codex session's transcript (TER-1095): Codex writes each session to
 * `<codex home>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl`, and its hooks report that
 * path as `transcript_path` next to `session_id` (a lowercase uuid, the same shape as Claude Code's).
 */

const TRANSCRIPT_MAX = 1024;

/** An absolute `<dir>/sessions/YYYY/MM/DD/rollout-<time>-<sessionId>.jsonl`, no `..` segment, no control character. */
export function isCodexTranscriptPath(p: unknown, sessionId: string): p is string {
  if (typeof p !== 'string' || p.length > TRANSCRIPT_MAX || !p.startsWith('/')) return false;
  if (/[\0-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.')) return false;
  const n = parts.length;
  if (n < 7 || parts[n - 5] !== 'sessions') return false;
  if (!/^\d{4}$/.test(parts[n - 4]) || !/^\d{2}$/.test(parts[n - 3]) || !/^\d{2}$/.test(parts[n - 2])) return false;
  const name = parts[n - 1];
  const suffix = `-${sessionId}.jsonl`;
  return name.startsWith('rollout-') && name.endsWith(suffix) && /^[0-9T:-]+$/.test(name.slice('rollout-'.length, -suffix.length));
}
