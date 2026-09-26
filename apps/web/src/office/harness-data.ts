/** Synthetic office for the harness (office-harness.html): pure, so the harness's own knobs can be tested. */
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, TabActivity, TabState } from '../lib/types';

export const HARNESS_STATES: Array<TabState | null> = ['working', 'working', 'working', 'waiting_input', 'waiting_permission', 'idle', 'idle', 'error', null];
const ACTIVITIES: TabActivity[] = ['coding', 'reading', 'researching', 'planning', 'terminal', 'working'];
/** Three machines, so one building's desks sit on several of them; two carry a subtitle for the desk tag. */
const MACHINES = [
  { id: 'm0', name: 'jarvis', subtitle: 'MacBook do escritório' },
  { id: 'm1', name: 'friday', subtitle: null },
  { id: 'm2', name: 'um-servidor-com-nome-comprido', subtitle: 'rack do porão, segunda prateleira' },
];

export interface HarnessOptions {
  /** how many buildings (projects) */
  projects: number;
  /** the most desks a building gets */
  desks: number;
  /** index of the machine drawn offline, -1 for none */
  offline: number;
  /** index of the machine whose tmux did not answer, -1 for none */
  silent: number;
  /** `?activity=<category>` on every working desk, `mix` to cycle the six, null for none */
  activity: string | null;
  /** `?verb=<Word>` with every activity */
  verb: string | null;
  at: string;
}

function activityFor(o: HarnessOptions, i: number, state: TabState | null): TabActivity | null {
  if (state !== 'working' || !o.activity) return null;
  return o.activity === 'mix' ? ACTIVITIES[i % ACTIVITIES.length] : (o.activity as TabActivity);
}

/**
 * Project 1 is empty and project 2 has one desk per HARNESS_STATES entry — with the simulator and
 * the dead tab in there, that building shows every desk the scene can draw. Desks rotate over the
 * three machines, so every building of more than one desk spans several of them.
 */
export function harnessCity(o: HarnessOptions): OfficeCity {
  const projects = Array.from({ length: Math.max(1, o.projects) }, (_, r): OfficeBuilding => {
    const id = `p${r}`;
    const count = r === 1 ? 0 : r === 2 ? Math.max(HARNESS_STATES.length, o.desks) : 1 + ((r * 5) % Math.max(1, o.desks));
    const tabs = Array.from({ length: count }, (_, i): OfficeTab => {
      const state = HARNESS_STATES[(r + i) % HARNESS_STATES.length];
      // i = 1 carries a task with no subtasks: no bar anywhere, its title only on hover
      const progress = i % 3 === 0 ? { task_id: 'k', title: 'Tarefa com subtarefas', done: i % 4, total: 4 } : i === 1 ? { task_id: 'k0', title: 'Tarefa sem subtarefas', done: 0, total: 0 } : null;
      const activity = activityFor(o, i, state);
      return {
        id: `${id}-t${i}`,
        project_id: id,
        machine_id: MACHINES[(r + i) % MACHINES.length].id,
        name: i === 0 ? 'um nome de aba bem comprido mesmo 🚀' : `aba ${i + 1}`,
        kind: i % 8 === 7 ? 'simulator' : 'terminal',
        tmux_session: null,
        simulator_udid: null,
        position: i,
        state,
        state_text: null,
        state_tool: null,
        state_at: state ? o.at : null,
        state_seen_at: null,
        activity,
        activity_verb: o.verb && activity ? o.verb : null,
        created_at: o.at,
        alive: i % 9 !== 4,
        ai_account_id: null,
        rate_limited_at: null,
        progress,
      };
    });
    return {
      project: {
        id,
        owner_id: 'u1',
        key: `P${r}`,
        next_task_number: 1,
        name: r === 0 ? 'projeto com um nome enorme para testar o corte' : `projeto-${r}`,
        status: r === 3 ? 'paused' : 'active',
        description: null,
        last_terminal_at: null,
        created_at: o.at,
        machines: [],
        is_public: false,
        public_id: `${id}-pub`,
      },
      public_id: `${id}-pub`,
      tabs,
      tasks: r % 2 ? { todo: 2, doing: 1, done: r } : null,
    };
  });
  const machines = MACHINES.map((m, i): OfficeMachine => ({ ...m, type: 'agent', online: i !== o.offline, reachable: i !== o.offline && i !== o.silent }));
  return { projects, machines };
}

/** The id of the desk `churned` adds and removes. */
export const CHURN_ID = 'churn';

/** `?churn=tabs`: the city with one extra desk in `projectId` (`on`) or without it — what a tab opened anywhere does. */
export function churned(city: OfficeCity, projectId: string, on: boolean): OfficeCity {
  return {
    ...city,
    projects: city.projects.map((b) => {
      if (b.project.id !== projectId) return b;
      const tabs = b.tabs.filter((t) => t.id !== CHURN_ID);
      return { ...b, tabs: on && tabs.length > 0 ? [...tabs, { ...tabs[0], id: CHURN_ID, name: 'aba recém-aberta', position: tabs.length }] : tabs };
    }),
  };
}

/** A random tenth of the desks change state: the harness's live mode. */
export function jiggled(city: OfficeCity, at: string, random: () => number = Math.random): OfficeCity {
  return {
    ...city,
    projects: city.projects.map((b) => ({ ...b, tabs: b.tabs.map((t) => (random() < 0.1 ? { ...t, state: HARNESS_STATES[Math.floor(random() * HARNESS_STATES.length)], state_at: at } : t)) })),
  };
}
