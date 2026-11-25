import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = { on: true, blocks: [] as unknown[] };
vi.mock('./blocks.js', () => ({
  openPermissionsOn: async () => flags.on,
  effectiveBlocks: async () => flags.blocks,
}));

const { answerAutoModePermission, resetAutoModeAnswers, AUTO_MODE_ANSWERS_PER_HOUR } = await import('./auto-mode-answer.js');
import type { TabQuestion } from '../db/repositories/tab-questions.js';
import type { Repositories } from '../db/repositories/index.js';

const wide = readFileSync(new URL('./fixtures/permission-dialogs/claude-auto-mode-unchecked.txt', import.meta.url), 'utf8');
const log = { info: vi.fn(), warn: vi.fn() };
const repos = { users: { findById: async (id: string) => ({ id }) } } as unknown as Repositories;
const card = (over: Partial<TabQuestion> = {}): TabQuestion =>
  ({ id: 'q1', tab_id: 't1', project_id: 'p1', user_id: 'u1', kind: 'permission', status: 'open', payload: { tool_name: 'Bash' }, ...over }) as TabQuestion;

/** A stand-in for answerTabQuestion: runs the caller's screen check on `screen`, and throws like the real one when it fails. */
const sender = (screen: string) =>
  vi.fn(async (_ctx: unknown, _id: string, _raw: unknown, deps: { via?: string; screenCheck?: (s: string) => boolean }) => {
    if (deps.via !== 'auto_mode' || deps.screenCheck?.(screen) !== true) throw Object.assign(new Error('not seen'), { code: 'TAB_PROMPT_NOT_SEEN' });
    return {} as never;
  });
const deps = (sendAnswer: ReturnType<typeof sender>, now = () => 0) => ({ repos, log, sleep: async () => {}, now, sendAnswer: sendAnswer as never });

beforeEach(() => {
  flags.on = true;
  flags.blocks = [];
  resetAutoModeAnswers();
  log.info.mockClear();
});

describe('answerAutoModePermission (TER-1210)', () => {
  it('answers "Yes" to the real auto mode dialog for a person on "liberado por padrão"', async () => {
    const send = sender(wide);
    expect(await answerAutoModePermission(deps(send), card())).toBe('allowed');
    expect(send).toHaveBeenCalledWith(expect.anything(), 'q1', { allow: true }, expect.objectContaining({ via: 'auto_mode' }));
  });
  it('leaves the card to a person with the flag off, without reading the screen', async () => {
    flags.on = false;
    const send = sender(wide);
    expect(await answerAutoModePermission(deps(send), card())).toBe('left');
    expect(send).not.toHaveBeenCalled();
  });
  it('leaves a card that is not a Claude Bash permission', async () => {
    const send = sender(wide);
    expect(await answerAutoModePermission(deps(send), card({ payload: { tool_name: 'Edit' } as never }))).toBe('left');
    expect(await answerAutoModePermission(deps(send), card({ payload: { tool_name: 'Bash', agent: 'codex' } as never }))).toBe('left');
    expect(await answerAutoModePermission(deps(send), card({ kind: 'choice' }))).toBe('left');
    expect(send).not.toHaveBeenCalled();
  });
  it('leaves the card when the screen shows a refused command, or a manual mode dialog', async () => {
    const refused = wide.replaceAll("rm -f src/zz-probe.mts'", "rm -rf src/'");
    expect(await answerAutoModePermission(deps(sender(refused)), card())).toBe('left');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ reason: 'recursive_rm' }), 'auto mode permission left to the person');
    const manual = readFileSync(new URL('./fixtures/permission-dialogs/claude-manual-unchecked.txt', import.meta.url), 'utf8');
    expect(await answerAutoModePermission(deps(sender(manual)), card())).toBe('left');
  });
  it("leaves the card when one of the person's blocks applies", async () => {
    flags.blocks = [{ kind: 'run_command', project_id: 'p1', words: ['docker'], effect: 'ask' }];
    expect(await answerAutoModePermission(deps(sender(wide)), card())).toBe('left');
  });
  it('stops at the hourly cap, and counts only what was sent', async () => {
    const send = sender(wide);
    for (let i = 0; i < AUTO_MODE_ANSWERS_PER_HOUR; i++) expect(await answerAutoModePermission(deps(send), card())).toBe('allowed');
    expect(await answerAutoModePermission(deps(send), card())).toBe('left');
    // an hour later it answers again
    expect(await answerAutoModePermission(deps(send, () => 60 * 60_000 + 1), card())).toBe('allowed');
  });
});
