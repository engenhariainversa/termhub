import { describe, expect, it } from 'vitest';
import { isCodexTranscriptPath } from './codex-session.js';

// a session id and file name as codex-cli 0.159.3 wrote them on jarvis
const SID = '01a15a42-e6fc-73d2-aca3-d44f5f84dd45';
const FILE = `rollout-2026-10-20T14-01-36-${SID}.jsonl`;

describe('isCodexTranscriptPath', () => {
  it('accepts <abs dir>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl', () => {
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/${FILE}`, SID)).toBe(true);
    expect(isCodexTranscriptPath(`/srv/codex-home/sessions/2026/10/20/${FILE}`, SID)).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isCodexTranscriptPath(`~/.codex/sessions/2026/10/20/${FILE}`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/${FILE}`, '6d127d73-4bd0-42d6-b4a6-d96899507e62')).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/archived/2026/10/20/${FILE}`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/x/${FILE}`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/../${FILE}`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/rollout-a/b-${SID}.jsonl`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/notes-${SID}.jsonl`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/.codex/sessions/2026/10/20/rollout-x\n-${SID}.jsonl`, SID)).toBe(false);
    expect(isCodexTranscriptPath(`/home/p/projects/proj/${SID}.jsonl`, SID)).toBe(false);
    expect(isCodexTranscriptPath(42, SID)).toBe(false);
  });
});
