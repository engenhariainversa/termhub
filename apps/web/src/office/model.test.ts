import { describe, expect, it } from 'vitest';
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, Project, Tab } from '../lib/types';
import { activityLabel, buildCityModel, deskMachineLine, lookOf, missingTabIds, resolveFocus, sameFocus, SUBTITLE_CAP, truncateLabel, workingLabel } from './model';

const AT = '2026-09-21T10:00:00.000Z';
const tab = (id: string, over: Partial<OfficeTab> = {}): OfficeTab =>
  ({ id, project_id: 'p1', machine_id: 'm1', name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, activity_verb: null, alive: true, progress: null, ...over }) as OfficeTab;
const building = (id: string, tabs: OfficeTab[], over: Partial<OfficeBuilding> = {}): OfficeBuilding => ({ project: { id, name: id, status: 'active' } as Project, public_id: `${id}-pub`, tabs: tabs.map((t) => ({ ...t, project_id: id })), tasks: null, ...over });
const machine = (id: string, over: Partial<OfficeMachine> = {}): OfficeMachine => ({ id, name: id, subtitle: null, type: 'agent', online: true, reachable: true, ...over });
const city = (projects: OfficeBuilding[], machines: OfficeMachine[] = [machine('m1')]): OfficeCity => ({ projects, machines });
const none = () => undefined;
/** the desks of the first building */
const desks = (c: OfficeCity, live: (id: string) => Tab | undefined = none) => buildCityModel(c, live).buildings[0].desks;

describe('buildCityModel: desks', () => {
  it('maps each tab state to a pose and a marker', () => {
    const c = city([building('p1', [
      tab('w', { state: 'working', state_at: AT }),
      tab('i', { state: 'waiting_input', state_at: AT }),
      tab('p', { state: 'waiting_permission', state_at: AT }),
      tab('z', { state: 'idle', state_at: AT }),
      tab('e', { state: 'error', state_at: AT }),
      tab('f', { state: 'finished', state_at: AT }),
      tab('n'),
    ])]);
    expect(desks(c).map((d) => [d.id, d.pose, d.marker, d.dimmed, d.screenOn])).toEqual([
      ['w', 'type', null, false, true],
      ['i', 'raise', 'input', false, false],
      ['p', 'raise', 'permission', false, false],
      ['z', 'sleep', null, false, false],
      ['e', 'shake', 'error', false, false],
      // done with a report (TER-972): at rest, no hand up, not counted as needing you
      ['f', 'sit', null, false, false],
      ['n', 'sit', null, true, false],
    ]);
    const m = buildCityModel(c, none);
    expect(m.buildings[0].needsYou).toBe(2);
    expect(m.needsYou).toBe(2);
  });

  it('carries the automatic run card onto its desk, and none on a manual tab or the public city', () => {
    const c = city([building('p1', [tab('a', { state: 'working', state_at: AT }), tab('b')])]);
    expect(buildCityModel(c, none, (id) => (id === 'a' ? 'TER-7' : undefined)).buildings[0].desks.map((d) => d.auto)).toEqual(['TER-7', null]);
    expect(desks(c).map((d) => d.auto)).toEqual([null, null]);
  });

  it('keeps the hand up but drops the marker once the tab was seen', () => {
    const seen = tab('i', { state: 'waiting_input', state_at: AT, state_seen_at: '2026-09-21T10:05:00.000Z' });
    const d = desks(city([building('p1', [seen])]))[0];
    expect([d.pose, d.marker]).toEqual(['raise', null]);
    expect(buildCityModel(city([building('p1', [seen])]), none).needsYou).toBe(0);
  });

  it('lets the live monitor state override the city, and a tab the monitor never saw stay as it is', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: AT } as Tab) : undefined);
    expect(desks(city([building('p1', [tab('a'), tab('b')])]), live).map((d) => d.pose)).toEqual(['type', 'sit']);
  });

  it('takes only the live state from the monitor tab, keeping the city identity fields and ordering', () => {
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), name: 'old name', position: 0, kind: 'simulator', state: 'working', state_at: AT } as Tab) : undefined);
    const ds = desks(city([building('p1', [tab('a', { name: 'new name', position: 1 }), tab('b', { position: 0 })])]), live);
    expect(ds.map((d) => d.id)).toEqual(['b', 'a']);
    expect([ds[1].name, ds[1].kind, ds[1].pose]).toEqual(['new name', 'person', 'type']);
  });

  it('shows an empty chair for a dead terminal tab and a phone for a simulator tab', () => {
    const ds = desks(city([building('p1', [tab('dead', { alive: false, state: 'working', state_at: 'x' }), tab('sim', { kind: 'simulator', alive: true })])]));
    expect([ds[0].pose, ds[0].marker, ds[0].screenOn]).toEqual(['empty', null, false]);
    expect([ds[1].kind, ds[1].screenOn]).toEqual(['phone', true]);
  });

  it('keeps people, markers and needsYou when the machine could not be asked', () => {
    // reachable: false means the tmux listing failed, so `alive: false` is not evidence of anything:
    // emptying the chairs there would erase every raised hand for up to a minute
    const c = city([building('p1', [tab('a', { alive: false, state: 'waiting_input', state_at: AT }), tab('sim', { kind: 'simulator', alive: false })])], [machine('m1', { reachable: false })]);
    const ds = desks(c);
    expect([ds[0].pose, ds[0].marker]).toEqual(['raise', 'input']);
    // a simulator's `alive` comes from the simulator manager, not from tmux: it still holds
    expect([ds[1].kind, ds[1].screenOn]).toEqual(['phone', false]);
    expect(buildCityModel(c, none).needsYou).toBe(1);
  });

  it('takes the state fields from whichever side saw them last', () => {
    const older = AT;
    const newer = '2026-09-21T10:05:00.000Z';
    const liveWith = (over: Partial<Tab>) => (id: string) => (id === 'a' ? ({ ...tab('a'), ...over } as Tab) : undefined);
    const fresh = desks(city([building('p1', [tab('a', { state: 'idle', state_at: older })])]), liveWith({ state: 'working', state_at: newer }))[0];
    expect([fresh.state, fresh.pose]).toEqual(['working', 'type']);
    const stale = desks(city([building('p1', [tab('a', { state: 'working', state_at: newer })])]), liveWith({ state: 'idle', state_at: older }))[0];
    expect([stale.state, stale.pose]).toEqual(['working', 'type']);
    const seen = desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: older })])]), liveWith({ state: 'waiting_input', state_at: older, state_seen_at: newer }))[0];
    expect(seen.marker).toBeNull();
  });

  it('draws progress only from a bound task, and a bar only when it has subtasks', () => {
    const ds = desks(city([building('p1', [tab('a', { progress: { task_id: 'k', title: 'Ship', done: 1, total: 3 } }), tab('b', { progress: { task_id: 'k2', title: 'Solo', done: 0, total: 0 } }), tab('c')])]));
    expect(ds.map((d) => d.progress)).toEqual([{ done: 1, total: 3, title: 'Ship' }, { done: 0, total: 0, title: 'Solo' }, null]);
  });

  it('orders desks by tab position and truncates labels without touching names', () => {
    const long = 'x'.repeat(120);
    const m = buildCityModel(city([building(long, [tab('second', { position: 1 }), tab('first', { position: 0, name: long })])]), none);
    expect(m.buildings[0].desks.map((d) => d.id)).toEqual(['first', 'second']);
    expect(m.buildings[0].desks[0].name).toBe(long);
    expect(m.buildings[0].desks[0].label.length).toBeLessThanOrEqual(18);
    expect(m.buildings[0].label.length).toBeLessThanOrEqual(28);
    expect(m.buildings[0].name).toBe(long);
  });
});

describe('buildCityModel: buildings', () => {
  it('makes one building per project, in the order given, empty ones kept', () => {
    const m = buildCityModel(city([building('b', []), building('a', [tab('t1')])]), none);
    expect(m.buildings.map((b) => [b.id, b.desks.length])).toEqual([['b', 0], ['a', 1]]);
  });

  // city-by-project §1: the machine is a detail of the desk
  it("puts a project's desks from every machine in its one building, each desk carrying its machine", () => {
    const c = city([building('p1', [tab('t1', { position: 0 }), tab('t2', { machine_id: 'm2', position: 1 })])], [machine('m1', { name: 'jarvis', subtitle: 'MacBook do escritório' }), machine('m2', { name: 'friday' })]);
    expect(desks(c).map((d) => [d.id, d.machine])).toEqual([
      ['t1', { name: 'jarvis', subtitle: 'MacBook do escritório', online: true }],
      ['t2', { name: 'friday', subtitle: null, online: true }],
    ]);
  });

  it('dims a desk whose machine is offline or unreachable, and only that desk', () => {
    const working = { state: 'working' as const, state_at: AT };
    const c = city(
      [building('p1', [tab('ok', { ...working, position: 0 }), tab('off', { ...working, machine_id: 'm2', position: 1 }), tab('mute', { ...working, machine_id: 'm3', position: 2 })])],
      [machine('m1'), machine('m2', { online: false, reachable: false }), machine('m3', { reachable: false })],
    );
    expect(desks(c).map((d) => [d.id, d.dimmed])).toEqual([['ok', false], ['off', true], ['mute', true]]);
    expect(desks(c)[1].machine).toEqual({ name: 'm2', subtitle: null, online: false });
  });

  it('says offline only when every machine of its desks is offline, silent when some tmux did not answer', () => {
    const on = (id: string, machineId: string) => tab(id, { machine_id: machineId });
    const ms = [machine('m1'), machine('m2', { online: false, reachable: false }), machine('m3', { reachable: false }), machine('m4', { online: false, reachable: null })];
    const m = buildCityModel(city([building('all-off', [on('a', 'm2'), on('b', 'm4')]), building('mixed', [on('c', 'm1'), on('d', 'm2')]), building('silent', [on('e', 'm3')]), building('fine', [on('f', 'm1')]), building('empty', [])], ms), none);
    expect(m.buildings.map((b) => [b.id, b.notice])).toEqual([['all-off', 'offline'], ['mixed', 'silent'], ['silent', 'silent'], ['fine', null], ['empty', null]]);
  });

  it('lights a building with someone at a desk or someone waiting, and leaves an empty or deserted one dark', () => {
    const m = buildCityModel(
      city(
        [
          building('busy', [tab('a')]),
          building('deserted', [tab('b', { alive: false })]),
          // its machine did not answer: the hand stays up, and so does the light
          building('waiting', [tab('c', { alive: false, machine_id: 'm9', state: 'waiting_input', state_at: AT })]),
          building('empty', []),
        ],
        [machine('m1'), machine('m9', { reachable: false })],
      ),
      none,
    );
    expect(m.buildings.map((b) => [b.id, b.lit])).toEqual([['busy', true], ['deserted', false], ['waiting', true], ['empty', false]]);
  });

  it('gives a building its board progress, none when the board is empty or unreadable', () => {
    const m = buildCityModel(city([building('a', [], { tasks: { todo: 1, doing: 1, done: 2 } }), building('b', [], { tasks: { todo: 0, doing: 0, done: 0 } }), building('c', [], { tasks: null })]), none);
    expect(m.buildings.map((b) => b.progress)).toEqual([{ done: 2, total: 4 }, null, null]);
  });

  it('sums who needs you per building and for the city', () => {
    const waiting = (id: string) => tab(id, { state: 'waiting_input', state_at: AT });
    const m = buildCityModel(city([building('a', [waiting('t1'), waiting('t2')]), building('b', [waiting('t3')])]), none);
    expect(m.buildings.map((b) => b.needsYou)).toEqual([2, 1]);
    expect(m.needsYou).toBe(3);
  });
});

describe('deskMachineLine', () => {
  it('is the machine name, with its subtitle when the two fit', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'MacBook', online: true })).toBe('jarvis · MacBook');
    expect(deskMachineLine({ name: 'jarvis', subtitle: null, online: true })).toBe('jarvis');
  });

  it('drops a subtitle that would not fit, and cuts a long name', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'um subtítulo comprido demais para a mesa', online: true })).toBe('jarvis');
    const long = deskMachineLine({ name: 'm'.repeat(60), subtitle: null, online: true });
    expect(Array.from(long)).toHaveLength(SUBTITLE_CAP);
    expect(long.endsWith('…')).toBe(true);
  });

  it('says offline in place of the subtitle', () => {
    expect(deskMachineLine({ name: 'jarvis', subtitle: 'MacBook', online: false })).toBe('jarvis · offline');
    expect(Array.from(deskMachineLine({ name: 'x'.repeat(60), subtitle: null, online: false })).length).toBeLessThanOrEqual(SUBTITLE_CAP);
  });

  it('is empty without a machine — the public city', () => {
    expect(deskMachineLine(null)).toBe('');
  });
});

describe('activity', () => {
  it('reaches the desk from the city and from a newer monitor push', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding' })])]))[0].activity).toBe('coding');
    const live = (id: string) => (id === 'a' ? ({ ...tab('a'), state: 'working', state_at: '2026-09-21T10:01:00.000Z', activity: 'reading' } as Tab) : undefined);
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding' })])]), live)[0].activity).toBe('reading');
  });
  it('is null when the tab is not working, whatever the city says', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: AT, activity: 'coding' })])]))[0].activity).toBeNull();
  });
  it('carries the spinner verb with the activity, and drops it off working or at an empty desk', () => {
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Brewing' })])]))[0].verb).toBe('Brewing');
    expect(desks(city([building('p1', [tab('a', { state: 'waiting_input', state_at: AT, activity: 'coding', activity_verb: 'Brewing' })])]))[0].verb).toBeNull();
    expect(desks(city([building('p1', [tab('a', { state: 'working', state_at: AT, activity: 'coding', activity_verb: 'Brewing', alive: false })])]))[0].verb).toBeNull();
  });
  it('shows "<Verb>…" before the activity label while working, and the activity alone without a verb', () => {
    expect(workingLabel('coding', 'Moonwalking')).toBe('Moonwalking… · codando');
    expect(workingLabel('reading', null)).toBe('lendo arquivos');
    expect(workingLabel(null, 'Brewing')).toBe('Brewing…');
    expect(workingLabel(null, null)).toBeNull();
    expect(Array.from(workingLabel('reading', 'Flibbertigibbeting')!)).toHaveLength(28);
  });
  it('labels every category in pt-BR and nothing for null', () => {
    expect(['coding', 'reading', 'researching', 'planning', 'terminal', 'working'].map((a) => activityLabel(a as never))).toEqual(['codando', 'lendo arquivos', 'pesquisando', 'planejando', 'no terminal', 'trabalhando']);
    expect(activityLabel(null)).toBeNull();
  });
});

describe('truncateLabel', () => {
  it('cuts by code point so an emoji is never split, and leaves short text alone', () => {
    expect(truncateLabel('api', 10)).toBe('api');
    expect(truncateLabel('🚀🚀🚀🚀🚀', 3)).toBe('🚀🚀…');
    expect(truncateLabel('  spaced   name  ', 20)).toBe('spaced name');
    expect(truncateLabel('', 5)).toBe('');
  });
});

describe('lookOf', () => {
  it('is stable for an id and spread over the variants', () => {
    expect(lookOf('tab-1', 6)).toBe(lookOf('tab-1', 6));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => lookOf(`tab-${i}`, 6)));
    expect(seen.size).toBe(6);
  });
});

describe('missingTabIds', () => {
  const c = city([building('p1', [tab('a')])]);
  const projectOf = (id: string) => ({ a: 'p1', b: 'p1', other: 'p9' })[id];
  it("returns the ids the monitor knows for one of the city's projects that the city lacks", () => {
    expect(missingTabIds(c, ['a', 'b'], projectOf)).toEqual(['b']);
  });
  it('leaves out tabs of projects outside the city and tabs it already knows', () => {
    expect(missingTabIds(c, ['a', 'other'], projectOf)).toEqual([]);
  });
  it('returns [] before the first read', () => {
    expect(missingTabIds(null, ['b'], projectOf)).toEqual([]);
  });
});

describe('resolveFocus', () => {
  const model = buildCityModel(city([building('p1', [tab('t')]), building('p2', [])]), none);
  it('frames the city with no project, an unknown one (an old machine id), or before anything loaded', () => {
    expect(resolveFocus(model, undefined)).toEqual({ kind: 'city' });
    expect(resolveFocus(model, 'm1')).toEqual({ kind: 'city' });
    expect(resolveFocus(null, 'p1')).toEqual({ kind: 'city' });
  });
  it('frames a building of the city, an empty one included', () => {
    expect(resolveFocus(model, 'p1')).toEqual({ kind: 'building', projectId: 'p1' });
    expect(resolveFocus(model, 'p2')).toEqual({ kind: 'building', projectId: 'p2' });
  });
  it('compares targets by value', () => {
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'building', projectId: 'a' })).toBe(true);
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'building', projectId: 'b' })).toBe(false);
    expect(sameFocus({ kind: 'building', projectId: 'a' }, { kind: 'city' })).toBe(false);
    expect(sameFocus({ kind: 'city' }, { kind: 'city' })).toBe(true);
  });
});
