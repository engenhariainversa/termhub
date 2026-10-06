import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { AutomationRun } from '../db/repositories/automation-runs.js';
import type { AutomationEventInput } from '../db/repositories/automation-events.js';
import type { AutoAnswer, TabQuestion } from '../db/repositories/tab-questions.js';
import type { ChoicePayload } from '../chat/tab-question-payload.js';

// the card's republish is the chat's business, not this module's
vi.mock('../chat/tab-questions.js', () => ({ publishTabQuestions: vi.fn(async () => []) }));
const { AUTOMATION_ANSWERS_MAX_PER_RUN, ANSWER_CYCLE_MAX, questionCycleHash, AUTOMATION_ANSWERS_MAX_PER_HOUR, automationAnswer, answerPermissionAutomatically, PERMISSION_SETTLE_MS, permissionAllowed, questionWithoutCard, recommendedOption, refusedCommand, RECOMMENDED_REASON } = await import('./answers.js');
const { ANSWER_CAP, ANSWER_CYCLE, ANSWER_RUN_CAP, PERMISSION_NEEDED, QUESTION_UNANSWERED } = await import('./follower.js');
const { DEFAULT_AUTOMATION_TOOLS } = await import('../control/agents.js');
const { normaliseLabel, parseAskUserQuestion } = await import('../chat/tab-question-payload.js');

type Item = ChoicePayload['questions'][number];
const item = (labels: Array<[string, boolean]>, question = 'Qual abordagem?', header = 'Abordagem'): Item => ({
  question,
  header,
  multi_select: false,
  options: labels.map(([label, recommended]) => ({ label, description: '', recommended })),
});
const one = (i: Item): ChoicePayload => ({ questions: [i] });

const card = (payload: ChoicePayload, over: Partial<TabQuestion> = {}): TabQuestion => ({
  id: 'q1', tab_id: 'tab1', project_id: 'p1', conversation_id: 'c1', user_id: 'u1', kind: 'choice', payload, tool_use_id: 'toolu_1',
  status: 'open', answer: null, error_code: null, answered_by: null, answered_at: null, closed_at: null, injected_at: null,
  created_at: '2026-10-05T12:00:00.000Z', suggestion: null, auto_answer: null, answered_via: null, woken_at: null, surfaced_at: null, ...over,
});

const run = (): AutomationRun => ({
  id: 'run1', project_id: 'p1', task_id: 't1', role: 'implementer', status: 'running', waiting_reason: null, tab_id: 'tab1', machine_id: 'm1', account_id: 'a1',
  branch: 'TER-1-card', worktree_path: '/w', resume_count: 0, fix_count: 0, restart_count: 0, allowed_tools: null, last_typed_at: null, woken_at: null, claimed_by: 'me',
  heartbeat_at: new Date(), started_at: new Date(), ended_at: null, created_at: new Date(),
});

function world(q: TabQuestion, o: { wakes?: boolean | 'throws'; noWaker?: boolean; openNow?: TabQuestion | undefined; answeredLastHour?: number; answeredInRun?: number; priorPayloads?: Array<Record<string, string | number | boolean | null>> } = {}) {
  const r = run();
  const events: AutomationEventInput[] = [];
  const scheduled: AutoAnswer[] = [];
  const repos = {
    tabQuestions: {
      setAutoAnswer: vi.fn(async (_id: string, auto: AutoAnswer) => (scheduled.push(auto), { ...q, auto_answer: auto })),
      findOpenForTab: vi.fn(async () => ('openNow' in o ? o.openNow : q)),
      cancelAutoAnswer: vi.fn(async (_id: string, _userId: string) => ({ ...q, auto_answer: { ...q.auto_answer!, status: 'cancelled' as const } })),
    },
    tabs: { findById: vi.fn(async () => ({ id: 'tab1', name: 'api' })) },
    automationRuns: {
      updateActive: vi.fn(async (_id: string, instance: string, patch: Partial<AutomationRun>) => {
        if (instance !== r.claimed_by) return false;
        Object.assign(r, patch);
        return true;
      }),
    },
    automationEvents: {
      insert: vi.fn(async (e: AutomationEventInput) => (events.push(e), { ...e, id: `e${events.length}`, created_at: '' })),
      countForRun: vi.fn(async (_runId: string, _kind: string, since: Date) => (since.getTime() === 0 ? (o.answeredInRun ?? o.answeredLastHour ?? 0) : (o.answeredLastHour ?? 0))),
      payloadsForRun: vi.fn(async () => o.priorPayloads ?? []),
    },
    projects: { findById: vi.fn(async () => ({ id: 'p1', owner_id: 'u1' })) },
  } as unknown as Repositories;
  const wake = vi.fn(async () => {
    if (o.wakes === 'throws') throw new Error('boom');
    return o.wakes ?? true;
  });
  const deps = { repos, waker: o.noWaker ? undefined : { wake } };
  return { run: r, events, scheduled, repos, deps, wake, kinds: () => events.map((e) => e.kind) };
}

describe('recommendedOption (F-18)', () => {
  it('reads the option the agent marked, by `recommended`', () => {
    expect(recommendedOption(one(item([['Worktree', true], ['Branch', false]])))).toBe('Worktree');
  });

  it('none, two marked, or a card of several questions → null', () => {
    expect(recommendedOption(one(item([['A', false], ['B', false]])))).toBeNull();
    expect(recommendedOption(one(item([['A', true], ['B', true]])))).toBeNull();
    expect(recommendedOption({ questions: [item([['A', true], ['B', false]]), item([['C', false], ['D', false]])] })).toBeNull();
  });

  it('"(Recomendado)" is recognised at parse time like "(Recommended)"', () => {
    expect(normaliseLabel('Azul (Recomendado)')).toEqual({ label: 'Azul', recommended: true });
    expect(normaliseLabel('Blue (Recommended)')).toEqual({ label: 'Blue', recommended: true });
    expect(normaliseLabel('(Recomendado)')).toEqual({ label: '(Recomendado)', recommended: false });
    const parsed = parseAskUserQuestion({ questions: [{ question: 'Qual?', header: 'H', options: [{ label: 'Sim (recomendado)', description: '' }, { label: 'Não', description: '' }] }] });
    expect(parsed && recommendedOption(parsed)).toBe('Sim');
  });
});

describe('automationAnswer (spec D18)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. a repeat already counting down wins: nothing else is scheduled or woken', async () => {
    const auto: AutoAnswer = { answer: { answers: [{ selected: [1] }] }, by: 'memory', reason: 'Mesma pergunta respondida antes', sources: [{ kind: 'decision', id: 'd1' }], due_at: '', status: 'scheduled' };
    const w = world(card(one(item([['Worktree', true], ['Branch', false]])), { auto_answer: auto }));
    expect(await automationAnswer(w.deps, card(one(item([['Worktree', true], ['Branch', false]])), { auto_answer: auto }), w.run)).toBe('repeat');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.events).toEqual([expect.objectContaining({ kind: 'question_answered', run_id: 'run1', payload: { via: 'repeat', tab_id: 'tab1', question_id: 'q1', cycle: expect.stringMatching(/^[0-9a-f]{16}$/) } })]);
  });

  it('2. the recommended option is scheduled with by "automation" and the usual 60 s countdown', async () => {
    const q = card(one(item([['Branch', false], ['Worktree', true]])));
    const w = world(q);
    const before = Date.now();
    expect(await automationAnswer(w.deps, q, w.run)).toBe('recommended');
    expect(w.scheduled).toHaveLength(1);
    const auto = w.scheduled[0]!;
    expect(auto).toMatchObject({ answer: { answers: [{ selected: [1] }] }, by: 'automation', reason: RECOMMENDED_REASON, sources: [], status: 'scheduled' });
    const due = Date.parse(auto.due_at) - before;
    expect(due).toBeGreaterThanOrEqual(59_000);
    expect(due).toBeLessThanOrEqual(61_000);
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.kinds()).toEqual(['question_answered']);
    expect(w.events[0]!.payload).toMatchObject({ via: 'recommended' });
    expect(w.run.status).toBe('running');
  });

  it('a "(Recomendado)" option the keyword block catches ("deploy") is never chosen: the chat is woken instead', async () => {
    const q = card(one(item([['Fazer deploy agora', true], ['Esperar', false]])));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).toHaveBeenCalledWith(q, 'api', { automatic: true });
  });

  it('the keyword block on the question itself also stops the recommended path', async () => {
    const q = card(one(item([['Sim', true], ['Não', false]], 'Faço o merge na main?', 'Merge')));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('two "(Recomendado)" options → none is chosen', async () => {
    const q = card(one(item([['A', true], ['B', true]])));
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('a card with several questions skips the recommended path', async () => {
    const q = card({ questions: [item([['A', true], ['B', false]]), item([['C', true], ['D', false]], 'Outra?', 'Outra')] });
    const w = world(q);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('woken');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
  });

  it('4. the wake budget spent (the waker says no) → the run waits for the person, escalated', async () => {
    const q = card(one(item([['A', false], ['B', false]])));
    const w = world(q, { wakes: false });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', run_id: 'run1', payload: { reason: QUESTION_UNANSWERED, tab_id: 'tab1' } })]);
  });

  it('no waker at all, or a wake that throws, also escalates', async () => {
    for (const o of [{ noWaker: true }, { wakes: 'throws' as const }]) {
      const q = card(one(item([['A', false], ['B', false]])));
      const w = world(q, o);
      expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
      expect(w.run.status).toBe('waiting');
    }
  });

  it('a card that moved on before the escalation is left alone (no escalation of a closed card)', async () => {
    const q = card(one(item([['A', false], ['B', false]])));
    const w = world(q, { wakes: false, openNow: undefined });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('closed');
    expect(w.run.status).toBe('running');
    expect(w.events).toEqual([]);
  });

  it('a recommended countdown that lost to one scheduled meanwhile counts as the repeat, never escalates', async () => {
    const q = card(one(item([['A', true], ['B', false]])));
    const counting = card(q.payload as ChoicePayload, { auto_answer: { answer: { answers: [{ selected: [0] }] }, by: 'concierge', reason: 'r', sources: [], due_at: '', status: 'scheduled' } });
    const w = world(q, { openNow: counting });
    vi.mocked(w.repos.tabQuestions.setAutoAnswer).mockResolvedValueOnce(undefined);
    expect(await automationAnswer(w.deps, q, w.run)).toBe('repeat');
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.run.status).toBe('running');
  });

  it('a permission card or a closed card is not touched', async () => {
    const w = world(card(one(item([['A', true], ['B', false]]))));
    expect(await automationAnswer(w.deps, card(one(item([['A', true], ['B', false]])), { kind: 'permission', payload: { tool_name: 'Bash' } }), w.run)).toBe('closed');
    expect(await automationAnswer(w.deps, card(one(item([['A', true], ['B', false]])), { status: 'answered_in_tab' }), w.run)).toBe('closed');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
  });
});

describe('the answer cap (review I2)', () => {
  beforeEach(() => vi.clearAllMocks());
  const now = new Date('2026-10-05T12:00:00.000Z');

  it('below the cap the recommended option is still scheduled; the count is the run\'s own answers of the last hour', async () => {
    const q = card(one(item([['A', true], ['B', false]])));
    const w = world(q, { answeredLastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR - 1, answeredInRun: 0 });
    expect(await automationAnswer({ ...w.deps, now: () => now }, q, w.run)).toBe('recommended');
    expect(w.repos.automationEvents.countForRun).toHaveBeenCalledWith('run1', 'question_answered', new Date(now.getTime() - 3600_000));
  });

  it('at the cap nothing is answered: the run waits for the person, escalated as answer_cap', async () => {
    const q = card(one(item([['A', true], ['B', false]])));
    const w = world(q, { answeredLastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: ANSWER_CAP });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: ANSWER_CAP, tab_id: 'tab1' } })]);
  });

  it('at the cap a memory repeat already counting down is cancelled, never sent', async () => {
    const auto: AutoAnswer = { answer: { answers: [{ selected: [0] }] }, by: 'memory', reason: 'r', sources: [{ kind: 'decision', id: 'd1' }], due_at: '', status: 'scheduled' };
    const q = card(one(item([['A', false], ['B', false]])), { auto_answer: auto });
    const w = world(q, { answeredLastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR + 3 });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.repos.tabQuestions.cancelAutoAnswer).toHaveBeenCalledWith('q1', 'u1');
    expect(w.kinds()).toEqual(['escalated']);
  });

  it('the next question past N answers escalates (N+1 questions in a run)', async () => {
    let answered = 0;
    const q = card(one(item([['A', true], ['B', false]])));
    const w = world(q);
    vi.mocked(w.repos.automationEvents.countForRun).mockImplementation(async () => answered);
    vi.mocked(w.repos.automationEvents.insert).mockImplementation(async (e: AutomationEventInput) => {
      if (e.kind === 'question_answered') answered++;
      w.events.push(e);
      return { ...e, id: 'e', created_at: '' } as never;
    });
    const outcomes: string[] = [];
    for (let i = 0; i <= AUTOMATION_ANSWERS_MAX_PER_RUN; i++) outcomes.push(await automationAnswer(w.deps, card(one(item([['A', true], ['B', false]], `Pergunta ${i}?`)), { id: `q${i}` }), w.run));
    expect(outcomes.slice(0, AUTOMATION_ANSWERS_MAX_PER_RUN).every((o) => o === 'recommended')).toBe(true);
    expect(outcomes.at(-1)).toBe('escalated');
    expect(w.run.waiting_reason).toBe(ANSWER_RUN_CAP);
  });
});

describe('answer cycle detector (TER-970, R7)', () => {
  it('the cycle counts over the whole run, not a window', async () => {
    const q = card(one(item([['A', true], ['B', false]], 'Qual nome de arquivo?')));
    const h = questionCycleHash(q.payload as ChoicePayload, { answers: [{ selected: [0] }] });
    const w = world(q, { priorPayloads: Array(ANSWER_CYCLE_MAX).fill({ via: 'recommended', cycle: h }) });
    await automationAnswer(w.deps, q, w.run);
    expect(w.repos.automationEvents.payloadsForRun).toHaveBeenCalledWith('run1', 'question_answered', new Date(0));
  });

  it('more than AUTOMATION_ANSWERS_MAX_PER_RUN answers in a run escalate as answer_run_cap, under the hourly cap', async () => {
    const q = card(one(item([['A', true], ['B', false]])));
    const w = world(q, { answeredLastHour: 0, answeredInRun: AUTOMATION_ANSWERS_MAX_PER_RUN });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.run.waiting_reason).toBe(ANSWER_RUN_CAP);
    const ok = world(q, { answeredInRun: AUTOMATION_ANSWERS_MAX_PER_RUN - 1 });
    expect(await automationAnswer(ok.deps, q, ok.run)).toBe('recommended');
  });

  const same = () => card(one(item([['A', true], ['B', false]], 'Qual nome de arquivo?')));

  it('answers a repeated question until ANSWER_CYCLE_MAX, then escalates as answer_cycle', async () => {
    const q = same();
    const h = questionCycleHash(q.payload as ChoicePayload, { answers: [{ selected: [0] }] });
    const ok = world(q, { priorPayloads: Array(ANSWER_CYCLE_MAX - 1).fill({ via: 'recommended', cycle: h }) });
    expect(await automationAnswer(ok.deps, q, ok.run)).toBe('recommended');
    expect(ok.events[0]!.payload).toMatchObject({ via: 'recommended', cycle: h });

    const w = world(q, { priorPayloads: Array(ANSWER_CYCLE_MAX).fill({ via: 'recommended', cycle: h }) });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.repos.tabQuestions.setAutoAnswer).not.toHaveBeenCalled();
    expect(w.wake).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: ANSWER_CYCLE });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: ANSWER_CYCLE, tab_id: 'tab1' } })]);
  });

  it('a different question, or another answer to it, does not count', async () => {
    const q = same();
    const other = questionCycleHash(one(item([['A', true], ['B', false]], 'Outra pergunta?')), { answers: [{ selected: [0] }] });
    const otherAnswer = questionCycleHash(q.payload as ChoicePayload, { answers: [{ selected: [1] }] });
    const w = world(q, { priorPayloads: [...Array(5).fill({ via: 'recommended', cycle: other }), ...Array(5).fill({ via: 'recommended', cycle: otherAnswer })] });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('recommended');
  });

  it('a memory repeat counting down is cancelled at the cycle', async () => {
    const answer = { answers: [{ selected: [0] }] };
    const auto: AutoAnswer = { answer, by: 'memory', reason: 'r', sources: [], due_at: '', status: 'scheduled' };
    const q = card(one(item([['A', false], ['B', false]], 'Qual nome de arquivo?')), { auto_answer: auto });
    const h = questionCycleHash(q.payload as ChoicePayload, answer);
    const w = world(q, { priorPayloads: Array(ANSWER_CYCLE_MAX).fill({ via: 'repeat', cycle: h }) });
    expect(await automationAnswer(w.deps, q, w.run)).toBe('escalated');
    expect(w.repos.tabQuestions.cancelAutoAnswer).toHaveBeenCalledWith('q1', 'u1');
    expect(w.run.waiting_reason).toBe(ANSWER_CYCLE);
  });

  it('keeps only a hash: the event payload never holds the question text', async () => {
    const q = same();
    const w = world(q);
    await automationAnswer(w.deps, q, w.run);
    expect(JSON.stringify(w.events)).not.toContain('nome de arquivo');
  });

  it('the hash is stable and tells questions and answers apart', () => {
    const p = one(item([['A', true], ['B', false]]));
    expect(questionCycleHash(p, { answers: [{ selected: [0] }] })).toBe(questionCycleHash(p, { answers: [{ selected: [0] }] }));
    expect(questionCycleHash(p, { answers: [{ selected: [0] }] })).not.toBe(questionCycleHash(p, { answers: [{ selected: [1] }] }));
  });
});

describe('a question with no card (review I1)', () => {
  it('parks the run for the person and escalates it', async () => {
    const w = world(card(one(item([['A', true], ['B', false]]))));
    await questionWithoutCard(w.repos, w.run);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: QUESTION_UNANSWERED });
    expect(w.kinds()).toEqual(['escalated']);
  });
});

describe('permissionAllowed (spec D19, §9.2, preflight F-6)', () => {
  const bash = (command: string | null) => ({ tool: 'Bash', command });
  /** No autonomy level is an input: a refusal holds at every one by construction. */
  const refused = (req: { tool: string; command: string | null }, allowed: string[], branch: string | null = 'TER-1-card') => !permissionAllowed(req, allowed, branch);

  it('a prefix rule `Bash(npm test:*)` allows the command and its arguments', () => {
    expect(permissionAllowed(bash('npm test -w x'), ['Bash(npm test:*)'])).toBe(true);
    expect(permissionAllowed(bash('npm test'), ['Bash(npm test:*)'])).toBe(true);
    expect(permissionAllowed(bash('  npm   test  -w   x '), ['Bash(npm test:*)'])).toBe(true);
  });

  it('a prefix rule matches on a word boundary only', () => {
    expect(permissionAllowed(bash('npm testx'), ['Bash(npm test:*)'])).toBe(false);
    expect(permissionAllowed(bash('npm tests -w x'), ['Bash(npm test:*)'])).toBe(false);
    expect(permissionAllowed(bash('npm tes'), ['Bash(npm test:*)'])).toBe(false);
  });

  it('an exact rule matches exactly; a prefix rule also takes arguments', () => {
    expect(permissionAllowed(bash('npm ci'), ['Bash(npm ci)'])).toBe(true);
    expect(permissionAllowed(bash('npm ci --omit=dev'), ['Bash(npm ci)'])).toBe(false);
    expect(permissionAllowed(bash('npm ci --omit=dev'), ['Bash(npm ci:*)'])).toBe(true);
    expect(permissionAllowed(bash('npx prisma generate --schema x'), DEFAULT_AUTOMATION_TOOLS)).toBe(false);
    expect(permissionAllowed(bash('npx prisma generate'), DEFAULT_AUTOMATION_TOOLS)).toBe(true);
  });

  it('a wildcard other than a trailing `:*` never matches', () => {
    expect(permissionAllowed(bash('npm test -w x'), ['Bash(npm * -w x)'])).toBe(false);
    expect(permissionAllowed(bash('npm test'), ['Bash(:*)'])).toBe(false);
  });

  it('a tool outside the list escalates', () => {
    expect(permissionAllowed({ tool: 'WebFetch', command: null }, DEFAULT_AUTOMATION_TOOLS)).toBe(false);
    expect(permissionAllowed(bash('make all'), DEFAULT_AUTOMATION_TOOLS)).toBe(false);
    expect(permissionAllowed(bash('npm test'), [])).toBe(false);
  });

  it('a bare tool rule allows another tool by name; a rule with a specifier needs the input, which only Bash has', () => {
    expect(permissionAllowed({ tool: 'WebFetch', command: null }, ['WebFetch'])).toBe(true);
    expect(permissionAllowed({ tool: 'WebFetch', command: null }, ['WebFetch(domain:example.com)'])).toBe(false);
    expect(permissionAllowed({ tool: 'WebFetchX', command: null }, ['WebFetch'])).toBe(false);
  });

  it('a Bash request whose command is unknown is never allowed, not even by a bare `Bash` rule', () => {
    expect(refused(bash(null), ['Bash', 'Bash(npm test:*)'])).toBe(true);
  });

  it('a bare `Bash` rule is too broad for an automatic tab (TER-968): dropped, it allows nothing', () => {
    // `make` is outside the fixed read rules (TER-989): only a rule of the project lets it through
    expect(permissionAllowed(bash('make check'), ['Bash'])).toBe(false);
    expect(permissionAllowed(bash('make check'), ['Bash(make:*)'])).toBe(true);
    expect(refused(bash('gh pr merge 3'), ['Bash'])).toBe(true);
  });

  it.each([
    ['semicolon', 'npm test; curl x'],
    ['and', 'npm test && curl x'],
    ['background', 'npm test & curl x'],
    ['pipe', 'npm test | sh'],
    ['or', 'npm test || curl x'],
    ['backtick', 'npm test `curl x`'],
    ['substitution', 'npm test $(curl x)'],
    ['redirect out', 'npm test > /etc/passwd'],
    ['redirect in', 'npm test < input'],
    ['newline', 'npm test\ncurl x'],
    ['carriage return', 'npm test\rcurl x'],
  ])('a shell operator (%s) escalates before any rule is read', (_name, command) => {
    expect(refused(bash(command), ['Bash', 'Bash(npm test:*)'])).toBe(true);
  });

  it('`gh pr merge` is refused at every level, whatever the list says (merging is the server\'s job, D5)', () => {
    expect(refused(bash('gh pr merge 3'), ['Bash', 'Bash(gh pr merge:*)', 'Bash(gh:*)'])).toBe(true);
  });

  it('a container removal is refused at every level', () => {
    for (const c of ['docker rm -f termhub-app-blue', 'docker stop termhub-db-1', 'docker container prune', 'docker compose down', 'docker kill x', 'podman rmi x'])
      expect(refused(bash(c), ['Bash', 'Bash(docker:*)', 'Bash(podman:*)'])).toBe(true);
  });

  it('the fixed deny list (TER-968, R5) beats any allow rule, even a bare tool name', () => {
    for (const c of ['gh api repos/o/r', 'gh secret list', 'eas build', 'fastlane beta', 'docker ps', 'psql -c x', 'security find-generic-password -s x -w', 'env A=1 docker ps', '/usr/bin/psql x', 'npx eas build'])
      expect(refused(bash(c), ['Bash', 'Bash(gh:*)', 'Bash(docker:*)', `Bash(${c})`]), c).toBe(true);
    for (const tool of ['Read', 'Edit', 'Write', 'NotebookEdit']) expect(refused({ tool, command: null }, [tool]), tool).toBe(true);
    // what the deny list does not name is still decided by the allow list
    expect(permissionAllowed(bash('gh pr view 3'), ['Bash(gh pr view:*)'])).toBe(true);
    expect(permissionAllowed(bash('ls -la'), ['Bash(ls:*)'])).toBe(true);
  });

  it('a project rule broad enough to reach a push or a denied command is dropped before matching (TER-968, review 1)', () => {
    for (const rule of ['Bash', 'Bash(*)', 'Bash(git:*)', 'Bash(git *)', 'Bash(gh:*)', 'Bash(sh -c:*)'])
      expect(permissionAllowed(bash('git status'), [rule]), rule).toBe(false);
    expect(permissionAllowed(bash('git status'), ['Bash(git status:*)'])).toBe(true);
  });

  it('the run\'s own push rules join the allow list, but a push is still never answered automatically (keyword block)', () => {
    expect(refusedCommand('git push -u origin TER-1-card', 'TER-1-card')).toBe(false);
    expect(permissionAllowed(bash('git push -u origin TER-1-card'), DEFAULT_AUTOMATION_TOOLS, 'TER-1-card')).toBe(false);
    expect(permissionAllowed(bash('git push origin HEAD:main'), ['Bash', 'Bash(git push:*)'], 'TER-1-card')).toBe(false);
  });

  it('the keyword block (memory/blocklist.ts) always escalates: on the command and on the tool name', () => {
    expect(permissionAllowed(bash('npm test -- --reset'), ['Bash(npm test:*)'])).toBe(false);
    expect(permissionAllowed(bash('git push origin HEAD'), DEFAULT_AUTOMATION_TOOLS)).toBe(false);
    expect(permissionAllowed({ tool: 'mcp__termhub__delete_task', command: null }, ['mcp__termhub__delete_task'])).toBe(false);
  });
});

describe('refusedCommand: refused at every level, whatever the allow list says (preflight F-6)', () => {
  it.each([
    'gh pr merge 3',
    'gh pr merge --squash --admin',
    'gh -R o/r pr merge 3',
    'git push --force',
    'git push -f origin HEAD',
    'git push -uf origin HEAD',
    'git push --force-with-lease origin HEAD',
    'git push --force-if-includes origin HEAD',
    'git push origin +HEAD',
    'git push origin HEAD:main',
    'git push origin HEAD:other',
    'git push origin :main',
    'git push origin main',
    'git push origin other-branch',
    'git push --delete origin TER-1-card',
    'git push --mirror',
    'git push --all origin',
    'git push --tags',
    'git push --exec=x origin HEAD',
    'git -C /w push origin main',
    'git -c alias.p=x p',
    'npm publish',
    'npm publish --tag next -w @termhub/agent',
    'pnpm publish',
    'npm run release',
    'npm run release:ota -w @termhub/mobile',
    'npm run-script release:ota',
    'eas build --platform ios',
    'npx eas update',
    'rm -rf dist',
    'rm -fr dist',
    'rm -r -f dist',
    'rm -R dist',
    'rm --recursive dist',
    '/bin/rm -rf /',
    'docker rm -f th-x',
  ])('%s', (command) => {
    expect(refusedCommand(command, 'TER-1-card')).toBe(true);
  });

  it.each([
    'git push origin TER-1-card',
    'git push -u origin TER-1-card',
    'git push origin HEAD:TER-1-card',
    'git push origin HEAD:refs/heads/TER-1-card',
    'git push -u origin HEAD:refs/heads/TER-1-card',
    'npm test -w x',
    'git status',
    'rm dist/a.js',
    'npm run build -w @termhub/web',
    'docker ps',
  ])('%s is not refused (the allow list still decides)', (command) => {
    expect(refusedCommand(command, 'TER-1-card')).toBe(false);
  });

  it.each(['git push', 'git push origin', 'git push origin HEAD', 'git push -u origin HEAD', 'git push upstream TER-1-card', 'git push origin TER-1-card other', 'git push origin HEAD:refs/heads/main'])(
    '%s is refused: only one refspec to origin naming the run\'s own branch (TER-968, R5)',
    (command) => {
      expect(refusedCommand(command, 'TER-1-card')).toBe(true);
    },
  );

  it('every push is refused when the run has no branch', () => {
    expect(refusedCommand('git push origin TER-1-card', null)).toBe(true);
    expect(refusedCommand('git push origin HEAD', null)).toBe(true);
  });
});

describe('permissionAllowed with the read rules every automatic tab gets (TER-989)', () => {
  const bash = (command: string) => ({ tool: 'Bash', command });

  it.each([
    'grep -rln Liberar apps/web/src',
    'rg -n project/: apps/web/src',
    'find apps -name *.ts',
    'ls -la apps',
    'cat package.json',
    'head -40 apps/server/src/app.ts',
    'git show HEAD~1',
    'git grep -n automationAllowList',
    'git ls-files apps/server',
    'git branch --show-current',
  ])('allows `%s` with an empty project list', (command) => {
    expect(permissionAllowed(bash(command), [], 'TER-1-card')).toBe(true);
  });

  it.each([
    'npm run i18n:check -w @termhub/web',
    'npm run build:packages',
    'npm run test -w @termhub/server',
    'gh pr diff 12',
    'gh run view 123 --log-failed',
    'git checkout origin/main -- package-lock.json',
  ])('allows the project command `%s` with the default list', (command) => {
    expect(permissionAllowed(bash(command), DEFAULT_AUTOMATION_TOOLS, 'TER-1-card')).toBe(true);
  });

  it.each([
    'find . -delete',
    'find . -execdir touch x {} +',
    'find . -fprint out',
    'rg --pre ./run.sh x',
    'git grep -O vim x',
    'git show --ext-diff HEAD',
    'git show --output=/tmp/x HEAD',
    'sort -o out in',
    'sort --compress-program=x in',
    'cat .env',
    'cat apps/server/.env.local',
    'grep -r token ~/.ssh',
    'cat ~/.config/gh/hosts.yml',
    'cat ~/.claude/.credentials.json',
    'ls ~/.aws/',
    'cat ~/.termhub/config.json',
    'cat /Users/x/.termhub/tabs/abc/token',
    'cat ~/.npmrc',
    'cat ~/.git-credentials',
    'git push origin main',
    'gh pr merge 12',
    'npm run release:ota',
    'docker ps',
  ])('still escalates `%s`', (command) => {
    expect(permissionAllowed(bash(command), DEFAULT_AUTOMATION_TOOLS, 'TER-1-card')).toBe(false);
  });

  it('still escalates a chained command, whose parts the server cannot see apart', () => {
    expect(permissionAllowed(bash('rg -n x apps | head -40'), DEFAULT_AUTOMATION_TOOLS, 'TER-1-card')).toBe(false);
  });
});

describe('answerPermissionAutomatically (spec §9.2)', () => {
  beforeEach(() => vi.clearAllMocks());

  const permissionCard = (tool = 'WebFetch', over: Partial<TabQuestion> = {}) => card(one(item([['A', false], ['B', false]])), { kind: 'permission', payload: { tool_name: tool }, tool_use_id: null, ...over });

  /** `world` plus what the pre-send check and the send read: the run still live, its card still tagged, the owner. */
  function permissionWorld(q: TabQuestion, o: { allowed?: string[] | null; setupTools?: string[] | null; paused?: boolean; enabled?: boolean; tagged?: boolean; liveRun?: 'same' | 'other' | 'none'; sendFails?: boolean; openNow?: TabQuestion | undefined; answeredLastHour?: number; priorPayloads?: Array<Record<string, string | number | boolean | null>> } = {}) {
    const w = world(q, { answeredLastHour: o.answeredLastHour, ...('openNow' in o ? { openNow: o.openNow } : {}) });
    w.run.allowed_tools = o.allowed === undefined ? ['WebFetch'] : o.allowed;
    const live = o.liveRun ?? 'same';
    Object.assign(w.repos, {
      automationRuns: { ...w.repos.automationRuns, activeByTab: vi.fn(async () => (live === 'none' ? null : live === 'other' ? { ...w.run, id: 'run2' } : w.run)) },
      projectSetup: { get: vi.fn(async () => ({ data: { automation: { enabled: o.enabled ?? true, autonomy: 'pr', allowed_tools: o.setupTools ?? null } } })) },
      automationPauses: { state: vi.fn(async () => ({ user: o.paused ? new Date() : null, project: null })) },
      tasks: { findById: vi.fn(async () => ({ id: 't1', auto: o.tagged ?? true })) },
      users: { findById: vi.fn(async () => ({ id: 'u1', email: 'o@x', role: 'admin' })) },
    });
    const sendAnswer = vi.fn(async () => {
      if (o.sendFails) throw Object.assign(new Error('gone'), { code: 'TAB_PROMPT_CHANGED' });
      return {} as never;
    });
    const sleep = vi.fn(async (_ms: number) => {});
    return { ...w, sendAnswer, sleep, pdeps: { ...w.deps, sendAnswer, sleep } };
  }

  it('a request the run\'s list allows is answered "allow" through the ordinary answer path, and recorded', async () => {
    const q = permissionCard();
    const w = permissionWorld(q);
    expect(await answerPermissionAutomatically(w.pdeps, q, w.run)).toBe('allowed');
    expect(w.sendAnswer).toHaveBeenCalledTimes(1);
    // the dialog is given time to be drawn before the live screen check
    expect(w.sleep).toHaveBeenCalledWith(PERMISSION_SETTLE_MS);
    expect(w.sleep.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(w.repos.automationRuns.activeByTab as never as () => void).mock.invocationCallOrder[0]!);
    expect(w.sendAnswer).toHaveBeenCalledWith(expect.objectContaining({ scope: expect.objectContaining({ ownerId: 'u1' }) }), 'q1', { allow: true }, expect.objectContaining({ embedder: null, via: 'automation' }));
    expect(w.events).toEqual([expect.objectContaining({ kind: 'question_answered', run_id: 'run1', payload: { via: 'permission', tab_id: 'tab1', question_id: 'q1' } })]);
    expect(w.run.status).toBe('running');
  });

  it('the list stored on the run wins over the setup; a run with none falls back to the setup', async () => {
    const q = permissionCard();
    const stored = permissionWorld(q, { allowed: ['Bash(npm test:*)'], setupTools: ['WebFetch'] });
    expect(await answerPermissionAutomatically(stored.pdeps, q, stored.run)).toBe('escalated');
    expect(stored.sendAnswer).not.toHaveBeenCalled();

    const fallback = permissionWorld(q, { allowed: null, setupTools: ['WebFetch'] });
    expect(await answerPermissionAutomatically(fallback.pdeps, q, fallback.run)).toBe('allowed');
  });

  it('a Bash request (the hook forwards no command) escalates: the run waits for the person, nothing is sent', async () => {
    const q = permissionCard('Bash');
    const w = permissionWorld(q, { allowed: DEFAULT_AUTOMATION_TOOLS });
    expect(await answerPermissionAutomatically(w.pdeps, q, w.run)).toBe('escalated');
    expect(w.sendAnswer).not.toHaveBeenCalled();
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: PERMISSION_NEEDED });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', payload: { reason: PERMISSION_NEEDED, tab_id: 'tab1' } })]);
  });

  it('with a command: an allowed one is answered, `gh pr merge` escalates', async () => {
    const q = permissionCard('Bash');
    const ok = permissionWorld(q, { allowed: DEFAULT_AUTOMATION_TOOLS });
    expect(await answerPermissionAutomatically(ok.pdeps, q, ok.run, 'npm test -w x')).toBe('allowed');
    const merge = permissionWorld(q, { allowed: [...DEFAULT_AUTOMATION_TOOLS, 'Bash(gh pr merge:*)'] });
    expect(await answerPermissionAutomatically(merge.pdeps, q, merge.run, 'gh pr merge 3')).toBe('escalated');
    expect(merge.sendAnswer).not.toHaveBeenCalled();
  });

  it('paused, disabled, untagged, or the tab\'s run changed right before sending: nothing is sent, the run is not touched, the card is left to the person (`left`: pushed as any other)', async () => {
    for (const o of [{ paused: true }, { enabled: false }, { tagged: false }, { liveRun: 'other' as const }, { liveRun: 'none' as const }]) {
      const q = permissionCard();
      const w = permissionWorld(q, o);
      expect(await answerPermissionAutomatically(w.pdeps, q, w.run)).toBe('left');
      expect(w.sendAnswer).not.toHaveBeenCalled();
      expect(w.repos.automationRuns.updateActive).not.toHaveBeenCalled();
      expect(w.events).toEqual([]);
    }
  });

  it('a send that fails on a card still open escalates; on a card that moved on it is `closed`', async () => {
    const q = permissionCard();
    const failed = permissionWorld(q, { sendFails: true });
    expect(await answerPermissionAutomatically(failed.pdeps, q, failed.run)).toBe('escalated');
    expect(failed.run.waiting_reason).toBe(PERMISSION_NEEDED);

    const moved = permissionWorld(q, { sendFails: true, openNow: undefined });
    expect(await answerPermissionAutomatically(moved.pdeps, q, moved.run)).toBe('closed');
    expect(moved.events).toEqual([]);
  });

  it('past the hourly cap of automatic answers the request goes to the person', async () => {
    const q = permissionCard();
    const w = permissionWorld(q, { answeredLastHour: AUTOMATION_ANSWERS_MAX_PER_HOUR });
    expect(await answerPermissionAutomatically(w.pdeps, q, w.run)).toBe('escalated');
    expect(w.sendAnswer).not.toHaveBeenCalled();
    expect(w.run.waiting_reason).toBe(ANSWER_CAP);
  });

  it('a card with no plain tool name escalates at once, before any rule is read', async () => {
    for (const payload of [{}, { tool_name: '' }, { tool_name: 'Web Fetch' }, { tool_name: 7 }, { tool_name: 'WebFetch(x)' }]) {
      const q = permissionCard('WebFetch', { payload: payload as never });
      const w = permissionWorld(q, { allowed: ['WebFetch', 'Bash'] });
      expect(await answerPermissionAutomatically(w.pdeps, q, w.run)).toBe('escalated');
      expect(w.sendAnswer).not.toHaveBeenCalled();
      expect(w.run.waiting_reason).toBe(PERMISSION_NEEDED);
    }
  });

  it('a choice card or a closed card is not touched', async () => {
    const choiceCard = card(one(item([['A', true], ['B', false]])));
    const w = permissionWorld(choiceCard);
    expect(await answerPermissionAutomatically(w.pdeps, choiceCard, w.run)).toBe('closed');
    expect(await answerPermissionAutomatically(w.pdeps, permissionCard('WebFetch', { status: 'answered' }), w.run)).toBe('closed');
    expect(w.sendAnswer).not.toHaveBeenCalled();
    expect(w.events).toEqual([]);
  });
});

describe('escalate (spec §9.3, TER-888)', () => {
  it('the run waits with the reason, `escalated` is recorded with the reason only, and the project chat gets the line', async () => {
    const q = card(one(item([['A', false], ['B', false]])));
    const w = world(q);
    const added: Array<{ conversation_id: string; text: string }> = [];
    Object.assign(w.repos, {
      users: { findById: vi.fn(async () => ({ id: 'u1', locale: null })) },
      tasks: { findById: vi.fn(async () => ({ id: 't1', project_id: 'p1', ref: 'TER-1' })) },
      tabQuestions: { ...w.repos.tabQuestions, latestQuestionForTab: vi.fn(async () => undefined) },
      chat: { findLatestActiveForProject: vi.fn(async () => ({ id: 'cp' })), addMessage: vi.fn(async (m: { conversation_id: string; text: string }) => (added.push(m), { id: 'm1', ...m })) },
    });
    const { escalate } = await import('./answers.js');
    await escalate(w.deps, w.run, PERMISSION_NEEDED);
    expect(w.run).toMatchObject({ status: 'waiting', waiting_reason: PERMISSION_NEEDED });
    expect(w.events).toEqual([expect.objectContaining({ kind: 'escalated', run_id: 'run1', payload: { reason: PERMISSION_NEEDED, tab_id: 'tab1' } })]);
    expect(added).toEqual([expect.objectContaining({ conversation_id: 'cp', text: "Automático parou em TER-1: O agente pediu uma permissão que as regras do projeto não liberam; responda no card." })]);
  });

  it('a run another instance drives is left alone: no event, no line', async () => {
    const w = world(card(one(item([['A', false]]))));
    const { escalate } = await import('./answers.js');
    await escalate(w.deps, { ...w.run, claimed_by: 'other' }, QUESTION_UNANSWERED);
    expect(w.events).toEqual([]);
  });
});
