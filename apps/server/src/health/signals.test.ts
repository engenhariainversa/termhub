import { describe, expect, it } from 'vitest';
import { healthSchema, type ProjectHealth } from '../setup/schema.js';
import { isDue, observe, type HealthSnapshot } from './signals.js';

const now = new Date('2026-10-27T15:00:00.000Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const config = (patch: Partial<ProjectHealth> = {}): ProjectHealth => ({ ...healthSchema.parse({}), ...patch });

const snap = (patch: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  now, automation: true, autonomy: 'release', base_branch: 'main', prs: [], base: null, queued: [], active_runs: 0, last_run_at: null,
  tabs: [], doing: [], runs: [], machines: [], min_agent_version: '0.27.0', ...patch,
});
const pr = (patch: Partial<HealthSnapshot['prs'][number]> = {}): HealthSnapshot['prs'][number] => ({
  url: 'https://github.com/o/r/pull/526', repo: 'o/r', number: 526, title: 'Fix', task_ref: 'TER-1', state: 'open', draft: false, ci_state: 'passed',
  base_ref: 'main', merged_at: null, deploy_state: 'none', deploy_url: null, release_runs: [], wait: null, ...patch,
});
const signals = (s: HealthSnapshot, c = config()) => observe(s, c).map((o) => `${o.signal}:${o.subject}`);

describe('observe (TER-1121)', () => {
  it('a green open PR with a merging autonomy is a ready PR, with why the executor holds it', () => {
    const [o] = observe(snap({ prs: [pr({ wait: 'merge_base_red' })] }), config());
    expect(o).toMatchObject({ signal: 'pr_ready', subject: 'https://github.com/o/r/pull/526', level: 'needs_you', since: null, detail: { label: '#526', reason: 'merge_base_red' } });
    // a draft, a red one, a merged one, or autonomy pr: nothing
    expect(signals(snap({ prs: [pr({ draft: true }), pr({ ci_state: 'failed', url: 'b' }), pr({ state: 'merged', url: 'c' })] }))).toEqual([]);
    expect(signals(snap({ autonomy: 'pr', prs: [pr()] }))).toEqual([]);
  });

  it('the base branch red or never finishing, never green', () => {
    expect(observe(snap({ base: { state: 'red', sha: 'abcdef1234', failing: ['TestFlight'] } }), config())[0]).toMatchObject({ signal: 'base_red', subject: 'main', detail: { state: 'red', sha: 'abcdef1', failing: 'TestFlight' } });
    expect(signals(snap({ base: { state: 'pending', sha: 'a', failing: [] } }))).toEqual(['base_red:main']);
    expect(signals(snap({ base: { state: 'green', sha: 'a', failing: [] } }))).toEqual([]);
  });

  it('a queue of todo cards with nothing running, unless the work is off or paused', () => {
    const queued = [{ task_id: 't1', ref: 'TER-1', reason: 'no_account', reason_text: 'Sem conta com folga', since: ago(300) }, { task_id: 't2', ref: 'TER-2', reason: null, reason_text: null, since: ago(200) }];
    const [o] = observe(snap({ queued, last_run_at: ago(90) }), config());
    expect(o).toMatchObject({ signal: 'queue_stalled', subject: 'queue', since: ago(90), detail: { label: '2', cards: 'TER-1 (Sem conta com folga); TER-2' } });
    expect(signals(snap({ queued, active_runs: 1 }))).toEqual([]);
    expect(signals(snap({ queued: [{ ...queued[0], reason: 'paused' }] }))).toEqual([]);
  });

  it('a type the Setup leaves out never starts: alone in the queue it is no alert (TER-1143)', () => {
    const spike = { task_id: 't3', ref: 'TER-3', reason: 'type_not_allowed', reason_text: 'Tipo não permitido no automático', since: ago(300) };
    expect(signals(snap({ queued: [spike], last_run_at: ago(90) }))).toEqual([]);
    const card = { task_id: 't4', ref: 'TER-4', reason: null, reason_text: null, since: ago(300) };
    const [o] = observe(snap({ queued: [spike, card], last_run_at: ago(90) }), config());
    expect(o).toMatchObject({ signal: 'queue_stalled', detail: { label: '1', cards: 'TER-4' } });
  });

  it('a new card in its first minutes is no stalled queue; the sign lasts since the oldest card waits (TER-1146)', () => {
    const fresh = { task_id: 't5', ref: 'TER-5', reason: 'just_created', reason_text: 'Card recém-criado; o automático começa em até 2 min', since: ago(1) };
    expect(signals(snap({ queued: [fresh], last_run_at: ago(180) }))).toEqual([]);
    // a card put in A fazer 5 min ago, the last start 3 h ago: 5 min, not yet due
    const card = { task_id: 't6', ref: 'TER-6', reason: null, reason_text: null, since: ago(5) };
    const [o] = observe(snap({ queued: [fresh, card], last_run_at: ago(180) }), config());
    expect(o).toMatchObject({ signal: 'queue_stalled', since: ago(5), detail: { label: '1', cards: 'TER-6' } });
    expect(isDue('queue_stalled', config(), o.since!, now)).toBe(false);
    // the oldest card waits 2 h and nothing ever started: due, with its age
    const [old] = observe(snap({ queued: [card, { ...card, task_id: 't7', ref: 'TER-7', since: ago(120) }] }), config());
    expect(old.since).toEqual(ago(120));
    expect(isDue('queue_stalled', config(), old.since!, now)).toBe(true);
  });

  it('tabs: working with no event is stuck, a question or the trust dialog is waiting, from the state time', () => {
    const tabs = [
      { id: 'a', name: 'a', state: 'working', state_at: ago(40), machine_id: 'm', run: true },
      { id: 'b', name: 'b', state: 'trust_prompt', state_at: ago(12), machine_id: 'm', run: false },
      { id: 'c', name: 'c', state: 'finished', state_at: ago(500), machine_id: 'm', run: false },
    ];
    const out = observe(snap({ tabs }), config());
    expect(out.map((o) => [o.signal, o.subject, o.since])).toEqual([['tab_stuck', 'a', ago(40)], ['tab_waiting', 'b', ago(12)]]);
  });

  it('a card in doing nobody works on is an orphan; a tab, a run, an open PR or a blocked run takes it out', () => {
    const card = { task_id: 't', ref: 'TER-9', title: 'x', since: ago(200), tab_alive: false, active_run: false, latest_run: 'done', open_pr: false };
    expect(signals(snap({ doing: [card] }))).toEqual(['card_orphan:t']);
    for (const p of [{ tab_alive: true }, { active_run: true }, { open_pr: true }, { latest_run: 'blocked' }]) expect(signals(snap({ doing: [{ ...card, ...p }] }))).toEqual([]);
  });

  it('a run escalated or blocked; a quota or GitHub wait resumes on its own', () => {
    const runs = [
      { id: 'r1', task_id: 't', ref: 'TER-1', status: 'waiting', waiting_reason: 'needs_person', ended_at: null },
      { id: 'r2', task_id: 't', ref: 'TER-2', status: 'blocked', waiting_reason: null, ended_at: ago(70) },
      { id: 'r3', task_id: 't', ref: 'TER-3', status: 'waiting', waiting_reason: 'quota', ended_at: null },
      { id: 'r4', task_id: 't', ref: 'TER-4', status: 'running', waiting_reason: null, ended_at: null },
    ];
    expect(observe(snap({ runs }), config()).map((o) => [o.subject, o.since])).toEqual([['r1', null], ['r2', ago(70)]]);
  });

  it('machines: offline with work, and an online agent below the minimum', () => {
    const m = { id: 'm', name: 'hulk', agent: true, online: false, last_seen_at: ago(20), agent_version: '0.30.0', active_run: true };
    expect(observe(snap({ machines: [m] }), config()).map((o) => [o.signal, o.since])).toEqual([['machine_offline', ago(20)]]);
    expect(signals(snap({ machines: [{ ...m, active_run: false }] }))).toEqual([]);
    expect(signals(snap({ machines: [{ ...m, online: true, agent_version: '0.26.1' }] }))).toEqual(['agent_outdated:m']);
    expect(signals(snap({ machines: [{ ...m, agent: false }] }))).toEqual([]);
  });

  it('only recent tab activity or an active run is work on an offline machine; tabs stuck for days are not (TER-1135)', () => {
    const m = { id: 'm', name: 'capitão américa', agent: true, online: false, last_seen_at: ago(20), agent_version: '0.30.0', active_run: false };
    const tab = (id: string, stateAt: Date, machine = 'm') => ({ id, name: id, state: 'working', state_at: stateAt, machine_id: machine, run: false });
    // TER-742 and TER-368: "trabalhando" with no event for days — their own sign, not the machine's work
    const stuck = [tab('TER-742', ago(3 * 24 * 60)), tab('TER-368', ago(2 * 24 * 60))];
    expect(signals(snap({ machines: [m], tabs: stuck }))).toEqual(['tab_stuck:TER-742', 'tab_stuck:TER-368']);
    // a tab busy shortly before the machine dropped is work, measured from its last sighting
    expect(signals(snap({ machines: [m], tabs: [tab('a', ago(45))] }))).toContain('machine_offline:m');
    expect(signals(snap({ machines: [m], tabs: [tab('a', ago(55))] }))).not.toContain('machine_offline:m');
    // another machine's tab is not this one's work
    expect(signals(snap({ machines: [m], tabs: [tab('a', ago(21), 'other')] }))).not.toContain('machine_offline:m');
  });

  it('the newest merge of a repo with a failed deploy or release; a later merge takes over', () => {
    const failed = pr({ state: 'merged', merged_at: ago(60), deploy_state: 'failed', release_runs: [{ workflow: 'Publish OTA', state: 'failed', url: 'u' }] });
    expect(signals(snap({ prs: [failed] }))).toEqual(['delivery_failed:https://github.com/o/r/pull/526#deploy', 'delivery_failed:https://github.com/o/r/pull/526#Publish OTA']);
    const later = pr({ url: 'x', number: 527, state: 'merged', merged_at: ago(10), deploy_state: 'passed' });
    expect(signals(snap({ prs: [failed, later] }))).toEqual([]);
  });

  it('without automatic work only the tab and machine signs run; disabled signs and the switch are honoured', () => {
    const s = snap({
      automation: false,
      prs: [pr()],
      tabs: [{ id: 'a', name: 'a', state: 'working', state_at: ago(40), machine_id: 'm', run: false }],
      machines: [{ id: 'm', name: 'hulk', agent: true, online: false, last_seen_at: ago(20), agent_version: '0.30.0', active_run: true }],
    });
    expect(signals(s)).toEqual(['tab_stuck:a', 'machine_offline:m']);
    const c = config();
    c.signals.tab_stuck.enabled = false;
    expect(signals(s, c)).toEqual(['machine_offline:m']);
    expect(signals(s, config({ enabled: false }))).toEqual([]);
  });

  it('isDue compares with the signal minutes', () => {
    expect(isDue('pr_ready', config(), ago(119), now)).toBe(false);
    expect(isDue('pr_ready', config(), ago(120), now)).toBe(true);
  });
});
