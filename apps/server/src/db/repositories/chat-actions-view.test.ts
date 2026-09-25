import { expect, it, vi } from 'vitest';
import type { ChatAction } from './chat-actions.js';
import { describeActions } from './chat-actions-view.js';

const OWNER = 'u1';
const OTHER_OWNER = 'u2';

const action = (over: Partial<ChatAction>): ChatAction => ({
  id: 'a1',
  conversation_id: 'c1',
  message_id: null,
  tool: 'send_input',
  args: {},
  class: 'write',
  status: 'pending',
  idempotency_key: null,
  machine_id: null,
  project_id: null,
  tab_id: null,
  grant_id: null,
  error_code: null,
  duration_ms: null,
  decided_by: null,
  decided_at: null,
  injected_at: null,
  created_at: '2026-09-21T00:00:00.000Z',
  ...over,
});

// This owner's own rows.
const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 2' };
const project = { id: 'p1', name: 'reactivando' };
const machine = { id: 'm1', name: 'macbook m3' };
const task = { id: 'tk1', project_id: 'p1', title: 'Corrigir o build', ref: 'REA-7' };

// Another user's rows — a proposed action naming one of these ids must never surface its name,
// title, or existence on this owner's card (the cross-tenant disclosure this fix closes).
const foreignTab = { id: 't9', project_id: 'p9', machine_id: 'm9', name: 'Aba Alheia' };
const foreignProject = { id: 'p9', name: 'Projeto Alheio' };
const foreignMachine = { id: 'm9', name: 'Máquina Alheia' };
const foreignTask = { id: 'tk9', project_id: 'p9', title: 'Tarefa Alheia' };

/** Each fake filters by `ownerId` exactly like the real `findByIdsForOwner` methods do: another
 * owner's id, or the wrong owner altogether, comes back empty — indistinguishable from "does not
 * exist". `OWNER` is the only owner whose fixtures ever resolve here. */
function fakeRepos() {
  return {
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(tab.id) ? [tab] : [])) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(project.id) ? [project] : [])) },
    machines: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(machine.id) ? [machine] : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(task.id) ? [task] : [])) },
  } as never;
}

it('reads like a sentence about the real world: the command, the tab, the project, the machine — never a raw tool name and three ids', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, tab_id: 't1' })], OWNER);
  expect(card.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(card.id).toBe('a1');
  expect(card.status).toBe('pending');
});

// A card cannot be placed in a chronological thread without its own timestamp. Asserting the exact
// value the row was given (not just "a string") catches a card built from `new Date()`, which would
// pass a shape check yet silently reorder the thread.
it('carries the row\'s created_at unchanged', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ created_at: '2020-01-02T03:04:05.000Z' })], OWNER);
  expect(card.created_at).toBe('2020-01-02T03:04:05.000Z');
});

it('resolves the project and machine through the tab when the row itself only carries a tab_id', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'run_command', args: { tab_id: 't1', command: 'ls -la' }, tab_id: 't1' })], OWNER);
  expect(card.summary).toBe('rodar o comando `ls -la` na aba Terminal 2 do projeto reactivando, no macbook m3');
});

it('describes a project-only action (no tab) with the project, not "na aba" — and no machine: a project has no single one', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'open_tab', args: { project_id: 'p1' }, project_id: 'p1' })], OWNER);
  expect(card.summary).toBe('abrir uma aba nova no projeto reactivando');
});

it('falls back to the verb alone when nothing at all can be resolved (no tab, no project, no task id)', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'create_task', args: { project_id: 'nope', title: 'Nova tarefa' } })], OWNER);
  expect(card.summary).toBe('criar a tarefa "Nova tarefa"');
});

it('names an unrecognised tool inside a sentence rather than showing it bare', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'do_something_new', args: {} })], OWNER);
  expect(card.summary).toBe('usar a ferramenta do_something_new');
});

// A task tool (add_subtasks/update_task/move_task/delete_task) never carries a machine/project/tab_id
// — its args only carry a task_id, which the gate never copies onto the row — so the task itself has
// to be resolved to say anything better than a bare id. delete_task is irreversible: this card is the
// only thing the user sees before authorising it, so approving by id alone would be approving blind.
it('names a delete_task card by the task\'s title and the project it belongs to — no machine: a task/project has no single one', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'delete_task', args: { task_id: 'tk1', confirm: true }, class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('apagar a tarefa REA-7 "Corrigir o build" no projeto reactivando');
});

it('names every other task tool by the task\'s title too', async () => {
  const repos = fakeRepos();
  const [addSubtasks] = await describeActions(repos, [action({ tool: 'add_subtasks', args: { task_id: 'tk1', subtasks: [{ title: 'x' }] } })], OWNER);
  expect(addSubtasks.summary).toBe('adicionar subtarefas à tarefa REA-7 "Corrigir o build" no projeto reactivando');

  const [updateTask] = await describeActions(repos, [action({ tool: 'update_task', args: { task_id: 'tk1', title: 'y' } })], OWNER);
  expect(updateTask.summary).toBe('atualizar a tarefa REA-7 "Corrigir o build" no projeto reactivando');

  const [moveTask] = await describeActions(repos, [action({ tool: 'move_task', args: { task_id: 'tk1', status: 'done' } })], OWNER);
  expect(moveTask.summary).toBe('mover a tarefa REA-7 "Corrigir o build" no projeto reactivando');
});

it('says plainly that a deleted task no longer exists, rather than falling back to its bare id — itself useful for deciding', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'delete_task', args: { task_id: 'ja-apagada', confirm: true }, class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('apagar uma tarefa que não existe mais');
  expect(card.summary).not.toContain('ja-apagada'); // the id itself is never a substitute for the fact
});

// The security fix: `describeActions` renders a card for one specific user (`OWNER`) and must only
// ever resolve names that user can see. A proposed action naming another user's id — exactly what a
// model reading a prompt-injected terminal screen would aim to supply — must read as "does not exist",
// never disclose the foreign row's name, and never distinguish "gone" from "not yours".
it('renders "does not exist" for a tab belonging to another user, and never leaks its name', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: foreignTab.id, text: 'oi' }, tab_id: foreignTab.id })], OWNER);
  expect(card.summary).toBe('digitar `oi` numa aba que não existe mais');
  expect(card.summary).not.toContain(foreignTab.name);
  expect(card.summary).not.toContain(foreignTab.id);
});

it('renders "does not exist" for a project belonging to another user, and never leaks its name', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'open_tab', args: { project_id: foreignProject.id }, project_id: foreignProject.id })], OWNER);
  expect(card.summary).toBe('abrir uma aba nova num projeto que não existe mais');
  expect(card.summary).not.toContain(foreignProject.name);
});

it('renders "does not exist" for a task belonging to another user, and never leaks its title', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'delete_task', args: { task_id: foreignTask.id, confirm: true }, class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('apagar uma tarefa que não existe mais');
  expect(card.summary).not.toContain(foreignTask.title);
});

it('renders "does not exist" for a machine belonging to another user, and never leaks its name', async () => {
  // No gated tool carries a bare machine_id today (see targetOf's callers), but the resolution is
  // defensive for whenever one does — the same rule must hold for it as for tab/project/task.
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'do_something_new', args: {}, machine_id: foreignMachine.id })], OWNER);
  expect(card.summary).toBe('usar a ferramenta do_something_new numa máquina que não existe mais');
  expect(card.summary).not.toContain(foreignMachine.name);
});

it('still resolves the owner\'s own tab/project/machine, and the batching call counts stay one per repository', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: tab.id, text: 'npm test' }, tab_id: tab.id })], OWNER);
  expect(card.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith([tab.id], OWNER);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledWith([project.id], OWNER);
  expect(repos.machines.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.machines.findByIdsForOwner).toHaveBeenCalledWith([machine.id], OWNER);
});

it('batches: one lookup per repository for the whole list, never one per action, and never at all when nothing to resolve', async () => {
  const repos = fakeRepos();
  await describeActions(
    repos,
    [
      action({ id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'a' }, tab_id: 't1' }),
      action({ id: 'a2', tool: 'send_input', args: { tab_id: 't1', text: 'b' }, tab_id: 't1' }),
      action({ id: 'a3', tool: 'delete_task', args: { task_id: 'tk1', confirm: true }, class: 'irreversible' }),
    ],
    OWNER,
  );
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith(['t1'], OWNER); // deduped, not called once per row
  expect(repos.tasks.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tasks.findByIdsForOwner).toHaveBeenCalledWith(['tk1'], OWNER);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1); // fed by both the tab's and the task's project_id
  expect(repos.machines.findByIdsForOwner).toHaveBeenCalledTimes(1);

  const repos2 = fakeRepos();
  await describeActions(repos2, [action({ tool: 'create_task', args: { project_id: 'nope', title: 'x' } })], OWNER);
  expect(repos2.tabs.findByIdsForOwner).not.toHaveBeenCalled(); // nothing to resolve: no query at all
  expect(repos2.tasks.findByIdsForOwner).not.toHaveBeenCalled();
  expect(repos2.machines.findByIdsForOwner).not.toHaveBeenCalled();
});

it('passes whichever owner the caller gives it straight through to every repository call, never a hardcoded one', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'a' }, tab_id: 't1' })], OTHER_OWNER);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith(['t1'], OTHER_OWNER);
  // From OTHER_OWNER's point of view, `tab` (fixture belongs to OWNER) does not exist either.
  expect(card.summary).toBe('digitar `a` numa aba que não existe mais');
});
