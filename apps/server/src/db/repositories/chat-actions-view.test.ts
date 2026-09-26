import { expect, it, vi } from 'vitest';
import type { ChatAction } from './chat-actions.js';
import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';
import { describeActions, describeGrantList, describeGrants, grantState } from './chat-actions-view.js';

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

// This owner's own rows. `created_by_token_id: null` is the default (opened in the browser) — the
// close_tab-specific tests below build their own variant with a token id, through `fakeRepos`'s
// `tab` override, rather than mutating this shared fixture other tests also read.
const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 2', created_by_token_id: null as string | null };
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
 * exist". `OWNER` is the only owner whose fixtures ever resolve here.
 *
 * `tabOverride` lets a close_tab test swap in a variant of `tab` with a different
 * `created_by_token_id`, without disturbing every other test that reads the shared fixture.
 * `apiTokens.listByUser` answers like the real, owner-scoped repository: `tokChat` is a gated
 * (concierge) token of this owner, `tokMine` is the owner's own (non-gated) token — tokens are
 * revoked, never deleted, so both keep showing up here regardless of revocation. */
function fakeRepos(tabOverride?: Partial<typeof tab>) {
  const t = { ...tab, ...tabOverride };
  return {
    tabs: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(t.id) ? [t] : [])) },
    projects: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(project.id) ? [project] : [])) },
    machines: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(machine.id) ? [machine] : [])) },
    tasks: { findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => (ownerId === OWNER && ids.includes(task.id) ? [task] : [])) },
    apiTokens: { listByUser: vi.fn(async (userId: string) => (userId === OWNER ? [{ id: 'tokChat', gated: true }, { id: 'tokMine', gated: false }] : [])) },
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

// The close_tab card names the tab's origin (TER-184) so the one confirmation the gate now asks for
// (Task 1: a gated token may close any of the user's tabs after this single "yes") is informed —
// the user is told plainly whether they are approving the chat closing its own tab or one of theirs.
// `apiTokens.listByUser` is the only extra, owner-scoped lookup this needs, and only when a
// close_tab card's tab actually resolved with a token id to classify.
it('says a close_tab card is closing a tab the chat itself opened, when the token is a gated one of this owner', async () => {
  const repos = fakeRepos({ created_by_token_id: 'tokChat' });
  const [card] = await describeActions(repos, [action({ tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('fechar a aba Terminal 2 (aberta pelo chat) do projeto reactivando, no macbook m3');
  expect(repos.apiTokens.listByUser).toHaveBeenCalledTimes(1);
  expect(repos.apiTokens.listByUser).toHaveBeenCalledWith(OWNER);
});

it('says a close_tab card is closing the user\'s own (browser-opened) tab when created_by_token_id is null', async () => {
  const repos = fakeRepos({ created_by_token_id: null });
  const [card] = await describeActions(repos, [action({ tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('fechar a aba Terminal 2 (aberta por você, não pelo chat) do projeto reactivando, no macbook m3');
});

it('says a close_tab card is closing a tab opened by another (non-gated) API token of the user\'s own', async () => {
  const repos = fakeRepos({ created_by_token_id: 'tokMine' });
  const [card] = await describeActions(repos, [action({ tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('fechar a aba Terminal 2 (aberta por um token de API seu, não pelo chat) do projeto reactivando, no macbook m3');
});

it('treats an unknown (revoked-and-gone, or foreign) token id the same as a non-gated one of the user\'s own', async () => {
  const repos = fakeRepos({ created_by_token_id: 'tok-does-not-exist' });
  const [card] = await describeActions(repos, [action({ tool: 'close_tab', args: { tab_id: 't1' }, tab_id: 't1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('fechar a aba Terminal 2 (aberta por um token de API seu, não pelo chat) do projeto reactivando, no macbook m3');
});

it('never looks up tokens for a close_tab card whose tab no longer resolves, and keeps the plain "gone" sentence', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'close_tab', args: { tab_id: foreignTab.id }, tab_id: foreignTab.id, class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('fechar a aba numa aba que não existe mais');
  expect(repos.apiTokens.listByUser).not.toHaveBeenCalled();
});

it('never looks up tokens for actions other than close_tab, even when their tab has a token id', async () => {
  const repos = fakeRepos({ created_by_token_id: 'tokChat' });
  const [card] = await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'npm test' }, tab_id: 't1' })], OWNER);
  expect(card.summary).toBe('digitar `npm test` na aba Terminal 2 do projeto reactivando, no macbook m3');
  expect(repos.apiTokens.listByUser).not.toHaveBeenCalled();
});

// link_project_machine/set_project_machine_cwd/unlink_project_machine carry both a project_id and a
// machine_id (targetOf copies both from args onto the row). Unlike open_tab/create_task above, the
// machine here is the key fact being approved, so `describeActions` names both — a project-scoped
// tool naming a machine is otherwise never correct (a project can link to 0–N machines), which is why
// this is limited to exactly these three tools (MACHINE_LINK_TOOLS) rather than a general rule.
it('names link_project_machine by the folder it links, in the project and on the machine', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(
    repos,
    [action({ tool: 'link_project_machine', args: { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }, project_id: 'p1', machine_id: 'm1' })],
    OWNER,
  );
  expect(card.summary).toBe('vincular a pasta `~/termhub` no projeto reactivando, no macbook m3');
});

it('says link_project_machine and set_project_machine_cwd are creating the folder when create_dir: true', async () => {
  const repos = fakeRepos();
  const [link] = await describeActions(
    repos,
    [action({ tool: 'link_project_machine', args: { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub', create_dir: true }, project_id: 'p1', machine_id: 'm1' })],
    OWNER,
  );
  expect(link.summary).toBe('vincular a pasta `~/termhub` (criando a pasta) no projeto reactivando, no macbook m3');

  const [setCwd] = await describeActions(
    repos,
    [action({ tool: 'set_project_machine_cwd', args: { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub', create_dir: true }, project_id: 'p1', machine_id: 'm1' })],
    OWNER,
  );
  expect(setCwd.summary).toBe('trocar a pasta para `~/termhub` (criando a pasta) no projeto reactivando, no macbook m3');
});

it('names set_project_machine_cwd by the new folder, in the project and on the machine', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(
    repos,
    [action({ tool: 'set_project_machine_cwd', args: { project_id: 'p1', machine_id: 'm1', cwd: '~/termhub' }, project_id: 'p1', machine_id: 'm1' })],
    OWNER,
  );
  expect(card.summary).toBe('trocar a pasta para `~/termhub` no projeto reactivando, no macbook m3');
});

it('names unlink_project_machine plainly without confirm, and says the tabs close with confirm: true — both naming the machine', async () => {
  const repos = fakeRepos();
  const [withoutConfirm] = await describeActions(
    repos,
    [action({ tool: 'unlink_project_machine', args: { project_id: 'p1', machine_id: 'm1' }, project_id: 'p1', machine_id: 'm1' })],
    OWNER,
  );
  expect(withoutConfirm.summary).toBe('desvincular a máquina no projeto reactivando, no macbook m3');

  const [withConfirm] = await describeActions(
    repos,
    [action({ tool: 'unlink_project_machine', args: { project_id: 'p1', machine_id: 'm1', confirm: true }, project_id: 'p1', machine_id: 'm1', class: 'irreversible' })],
    OWNER,
  );
  expect(withConfirm.summary).toBe('desvincular a máquina (fechando as abas do projeto nela, se houver) no projeto reactivando, no macbook m3');
});

it('says the machine does not exist for a link tool whose machine is gone or foreign, rather than a bare id — the project still resolves', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(
    repos,
    [action({ tool: 'link_project_machine', args: { project_id: 'p1', machine_id: foreignMachine.id, cwd: '~/termhub' }, project_id: 'p1', machine_id: foreignMachine.id })],
    OWNER,
  );
  expect(card.summary).toBe('vincular a pasta `~/termhub` numa máquina que não existe mais');
  expect(card.summary).not.toContain(foreignMachine.name);
  expect(card.summary).not.toContain(foreignMachine.id);
});

it('says the project does not exist for a link tool whose project is gone or foreign, even when the machine resolves', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(
    repos,
    [action({ tool: 'unlink_project_machine', args: { project_id: foreignProject.id, machine_id: 'm1', confirm: true }, project_id: foreignProject.id, machine_id: 'm1', class: 'irreversible' })],
    OWNER,
  );
  expect(card.summary).toBe('desvincular a máquina (fechando as abas do projeto nela, se houver) num projeto que não existe mais');
  expect(card.summary).not.toContain(foreignProject.name);
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

const grant = (over: Partial<ChatGrant>): ChatGrant => ({
  id: 'g1',
  conversation_id: 'c1',
  tab_id: 't1',
  tool: 'send_input',
  source_action_id: 'a1',
  granted_by: OWNER,
  created_at: '2026-09-25T10:00:00.000Z',
  expires_at: '2026-09-26T10:00:00.000Z',
  revoked_at: null,
  revoked_by: null,
  ...over,
});

it('describeGrants names the grant\'s tab, dropping every user id', async () => {
  const repos = fakeRepos();
  const [view] = await describeGrants(repos, [grant({ tab_id: tab.id })], OWNER);
  expect(view).toEqual({ id: 'g1', tab_id: tab.id, tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', tab_name: tab.name });
});

it('describeGrants says the tab does not exist for a gone or foreign tab, never leaking its name', async () => {
  const repos = fakeRepos();
  const [view] = await describeGrants(repos, [grant({ tab_id: foreignTab.id })], OWNER);
  expect(view.tab_name).toBeNull();
});

it('describeGrants batches: one lookup for the whole list, deduped, and none at all for an empty list', async () => {
  const repos = fakeRepos();
  await describeGrants(repos, [grant({ id: 'g1', tab_id: tab.id }), grant({ id: 'g2', tab_id: tab.id })], OWNER);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith([tab.id], OWNER);

  const repos2 = fakeRepos();
  await describeGrants(repos2, [], OWNER);
  expect(repos2.tabs.findByIdsForOwner).not.toHaveBeenCalled();
});

const NOW = new Date('2026-09-25T12:00:00.000Z');
const listed = (over: Partial<ChatGrantWithConversation>): ChatGrantWithConversation => ({ ...grant({}), conversation_project_id: null, conversation_archived: false, ...over });

it('grantState: active, expired, revoked by a person, ended by "Nova conversa"', () => {
  expect(grantState(grant({}), NOW)).toBe('active');
  expect(grantState(grant({ expires_at: '2026-09-25T11:00:00.000Z' }), NOW)).toBe('expired');
  expect(grantState(grant({ revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER }), NOW)).toBe('revoked');
  expect(grantState(grant({ revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }), NOW)).toBe('ended');
});

it('grantState: a grant that expired before a reset or a re-grant revoked it reads expired', () => {
  expect(grantState(grant({ expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }), NOW)).toBe('expired');
  expect(grantState(grant({ expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER }), NOW)).toBe('expired');
});

it('describeGrantList names the tab, its project and the origin conversation, with state and ended_at', async () => {
  const repos = fakeRepos();
  const [active, revoked, expiredThenReset] = await describeGrantList(
    repos,
    [
      listed({ id: 'g1', tab_id: tab.id, conversation_project_id: project.id }),
      listed({ id: 'g2', tab_id: tab.id, revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER, conversation_archived: true }),
      listed({ id: 'g3', tab_id: foreignTab.id, expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }),
    ],
    OWNER,
    NOW,
  );
  expect(active).toEqual({
    id: 'g1', tab_id: tab.id, tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: tab.name, project_id: project.id, project_name: project.name, conversation_id: 'c1', conversation_project_name: project.name,
    conversation_archived: false, state: 'active', ended_at: null,
  });
  expect(revoked).toMatchObject({ state: 'revoked', ended_at: '2026-09-25T11:00:00.000Z', conversation_project_name: null, conversation_archived: true });
  expect(expiredThenReset).toMatchObject({ state: 'expired', ended_at: '2026-09-25T09:00:00.000Z', tab_name: null, project_id: null, project_name: null });
});

it('describeGrantList batches one lookup per kind, owner-scoped, and none for an empty list', async () => {
  const repos = fakeRepos();
  await describeGrantList(repos, [listed({ id: 'g1', tab_id: tab.id, conversation_project_id: project.id }), listed({ id: 'g2', tab_id: tab.id })], OWNER, NOW);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.tabs.findByIdsForOwner).toHaveBeenCalledWith([tab.id], OWNER);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledWith([project.id], OWNER);
  const empty = fakeRepos();
  expect(await describeGrantList(empty, [], OWNER, NOW)).toEqual([]);
  expect(empty.tabs.findByIdsForOwner).not.toHaveBeenCalled();
  expect(empty.projects.findByIdsForOwner).not.toHaveBeenCalled();
});
