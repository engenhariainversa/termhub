import { describe, expect, it } from 'vitest';
import { CHURN_ID, churned, HARNESS_STATES, harnessAutoRef, harnessCity, jiggled } from './harness-data';
import { buildCityModel } from './model';

const opts = { projects: 6, desks: 8, offline: -1, silent: -1, activity: null, verb: null, at: '2026-09-24T10:00:00.000Z' };

describe('harnessCity', () => {
  it('makes ?projects= buildings: the second empty, the third with every desk the scene can draw', () => {
    const city = harnessCity(opts);
    expect(city.projects.map((b) => b.project.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(city.projects[1].tabs).toEqual([]);
    expect(city.projects[2].tabs.length).toBeGreaterThanOrEqual(HARNESS_STATES.length);
    expect(new Set(city.projects[2].tabs.map((t) => t.kind))).toEqual(new Set(['terminal', 'simulator']));
  });

  it('spreads a building over several machines, every desk on a machine the city describes', () => {
    const city = harnessCity(opts);
    const ids = new Set(city.machines.map((m) => m.id));
    expect(city.projects.flatMap((b) => b.tabs).every((t) => ids.has(t.machine_id))).toBe(true);
    expect(new Set(city.projects[2].tabs.map((t) => t.machine_id)).size).toBeGreaterThan(1);
  });

  it('puts one machine offline and another silent with ?offline= and ?silent=', () => {
    const city = harnessCity({ ...opts, offline: 1, silent: 2 });
    expect(city.machines.map((m) => [m.id, m.online, m.reachable])).toEqual([['m0', true, true], ['m1', false, false], ['m2', true, false]]);
    expect(buildCityModel(city, () => undefined).buildings.some((b) => b.notice === 'silent')).toBe(true);
  });

  it('churns one desk in and out of one building, leaving the others alone', () => {
    const city = harnessCity(opts);
    const on = churned(city, 'p0', true);
    expect(on.projects[0].tabs.at(-1)?.id).toBe(CHURN_ID);
    expect(on.projects[2]).toBe(city.projects[2]);
    expect(churned(on, 'p0', false).projects[0].tabs.map((t) => t.id)).toEqual(city.projects[0].tabs.map((t) => t.id));
  });

  it('jiggles states without adding or losing desks', () => {
    const city = harnessCity(opts);
    const next = jiggled(city, 'x', () => 0);
    expect(next.projects.map((b) => b.tabs.length)).toEqual(city.projects.map((b) => b.tabs.length));
    expect(next.projects[0].tabs[0].state_at).toBe('x');
  });

  it('makes every third desk an automatic run with ?auto=1', () => {
    expect(['p2-t0', 'p2-t1', 'p2-t4', 'p0-t2', 'churn'].map(harnessAutoRef)).toEqual([undefined, 'TER-101', 'TER-104', undefined, undefined]);
  });
});
