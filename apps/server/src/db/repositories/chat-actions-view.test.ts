import { expect, it, vi } from 'vitest';
import type { ChatAction } from './chat-actions.js';
import type { ChatGrant, ChatGrantWithConversation } from './chat-grants.js';
import type { ChatProjectGrant, ChatProjectGrantWithConversation } from './chat-project-grants.js';
import type { ChatStandingGrantWithConversation } from './chat-standing-grants.js';
import { describeActions, describeGrantList, describeGrants, describeProjectGrantList, describeProjectGrants, describeStandingGrantList, describeStandingGrants, grantState } from './chat-actions-view.js';

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
  tool_use_id: null,
  subagent_id: null,
  created_at: '2026-09-21T00:00:00.000Z',
  surfaced_at: null,
  ...over,
});

// This owner's own rows. `created_by_token_id: null` is the default (opened in the browser) — the
// close_tab-specific tests below build their own variant with a token id, through `fakeRepos`'s
// `tab` override, rather than mutating this shared fixture other tests also read.
const tab = { id: 't1', project_id: 'p1', machine_id: 'm1', name: 'Terminal 2', created_by_token_id: null as string | null };
const project = { id: 'p1', name: 'reactivando' };
const machine = { id: 'm1', name: 'macbook m3' };
const task = { id: 'tk1', project_id: 'p1', title: 'Corrigir o build', ref: 'REA-7' };
const linkedTask = { id: 'tk2', project_id: 'p1', title: 'Ajustar layout', ref: 'REA-8', status: 'doing', external_ref: { provider: 'linear', key: 'EI-1', provider_id: 'u', status: 'done' } };
const ticketRows = Array.from({ length: 12 }, (_, i) => ({ id: `ticket-${i + 1}`, key: `EI-${i + 1}` }));

// Another user's rows — a proposed action naming one of these ids must never surface its name,
// title, or existence on this owner's card (the cross-tenant disclosure this fix closes).
const foreignTab = { id: 't9', project_id: 'p9', machine_id: 'm9', name: 'Aba Alheia' };
const foreignProject = { id: 'p9', name: 'Projeto Alheio' };
const foreignMachine = { id: 'm9', name: 'Máquina Alheia' };
const foreignTask = { id: 'tk9', project_id: 'p9', title: 'Tarefa Alheia' };

// A subagent (`chat_subagents`, spec 2026-09-26 §4) that proposed an action, and one that belongs to
// another conversation entirely — resolving that one must read as "no subagent", exactly like every
// other cross-scope reference this view is careful never to disclose.
// A decision of this owner's (TER-641), cited by a send the concierge made on a precedent.
const ownDecision = { id: 'd1', question: 'Rodo os testes?', answer: { labels: ['Sim'] } };
const subagent = { id: 'sub1', conversation_id: 'c1', description: 'Escrever testes' };
const otherConversationSubagent = { id: 'sub9', conversation_id: 'c9', description: 'De outra conversa' };

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
    tasks: {
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => {
        if (ownerId !== OWNER) return [];
        return [task, linkedTask].filter((k) => ids.includes(k.id));
      }),
    },
    tickets: {
      findByIdsForOwner: vi.fn(async (ids: string[], ownerId: string) => {
        if (ownerId !== OWNER) return [];
        return ticketRows.filter((k) => ids.includes(k.id));
      }),
    },
    integrations: { list: vi.fn(async (ownerId: string) => (ownerId === OWNER ? [{ id: 'g1', provider: 'github', name: 'GitHub ana', owner_id: OWNER }] : [{ id: 'g9', provider: 'github', name: 'Integração Alheia', owner_id: OTHER_OWNER }])) },
    apiTokens: { listByUser: vi.fn(async (userId: string) => (userId === OWNER ? [{ id: 'tokChat', gated: true }, { id: 'tokMine', gated: false }] : [])) },
    // No owner scoping of its own (chat_subagents belongs to a conversation, not a user) — the
    // conversation check inside `describeActions` is what keeps a foreign-conversation row from
    // ever being named on a card.
    chatSubagents: { listByIds: vi.fn(async (ids: string[]) => [subagent, otherConversationSubagent].filter((s) => ids.includes(s.id))) },
    // Owner-scoped like the real `findManyForUser`: another user's decision resolves to nothing.
    chatDecisions: { findManyForUser: vi.fn(async (ids: string[], userId: string) => (userId === OWNER ? [ownDecision].filter((d) => ids.includes(d.id)) : [])) },
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
it('carries error_code and surfaced_at for the card to say why it ended and where it sits (TER-477)', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ status: 'failed', error_code: 'TAB_GONE', surfaced_at: '2026-09-30T06:00:00.000Z' })], OWNER);
  expect(card).toMatchObject({ error_code: 'TAB_GONE', surfaced_at: '2026-09-30T06:00:00.000Z' });
  const [plain] = await describeActions(repos, [action({})], OWNER);
  expect(plain).toMatchObject({ error_code: null, surfaced_at: null });
});

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

// TER-499: link_tab_task carries a tab_id (copied onto the row) and a task_id (read from args): the card
// names both, since what the user approves is "this card shows that tab".
it('names the card and the tab of a link_tab_task, and says so when either is gone', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'link_tab_task', args: { tab_id: 't1', task_id: 'tk1' }, tab_id: 't1' })], OWNER);
  expect(card.summary).toBe('ligar a tarefa REA-7 "Corrigir o build" na aba Terminal 2 do projeto reactivando, no macbook m3');

  const [noTask] = await describeActions(repos, [action({ tool: 'link_tab_task', args: { tab_id: 't1', task_id: 'gone' }, tab_id: 't1' })], OWNER);
  expect(noTask.summary).toBe('ligar uma tarefa que não existe mais na aba Terminal 2 do projeto reactivando, no macbook m3');

  const [noTab] = await describeActions(repos, [action({ tool: 'link_tab_task', args: { tab_id: 'gone', task_id: 'tk1' }, tab_id: 'gone' })], OWNER);
  expect(noTab.summary).toBe('ligar a tarefa REA-7 "Corrigir o build" numa aba que não existe mais');
});

it('sync_tickets reads as fetching every source, no task or location involved', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'sync_tickets', args: { project_id: 'p1' } })], OWNER);
  expect(card.summary.startsWith('sincronizar os tickets de todas as fontes')).toBe(true);
});

it('import_tickets names the keys and how many, pluralizing the noun', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'import_tickets', args: { project_id: 'p1', keys: ['EI-1', 'EI-2'] } })], OWNER);
  expect(card.summary.startsWith('importar 2 tickets para o backlog: EI-1, EI-2')).toBe(true);
});

it('import_tickets uses the singular noun for one ticket', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'import_tickets', args: { project_id: 'p1', keys: ['EI-1'] } })], OWNER);
  expect(card.summary.startsWith('importar 1 ticket para o backlog: EI-1')).toBe(true);
});

// The gap the fix closes: with ticket_ids (no keys) the old sentence named nothing at all —
// "importar N tickets para o backlog" — so the person approved blind. Resolving them through the
// same owner-scoped batch as tabs/tasks means the card names exactly what would be imported.
it('import_tickets with ticket_ids resolves them to keys through the owner-scoped batch', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'import_tickets', args: { project_id: 'p1', ticket_ids: ['ticket-1', 'ticket-2'] } })], OWNER);
  expect(card.summary.startsWith('importar 2 tickets para o backlog: EI-1, EI-2')).toBe(true);
});

it('import_tickets lists at most 10 keys, then "e mais N" for the rest', async () => {
  const repos = fakeRepos();
  const ids = ticketRows.map((t) => t.id); // 12 tickets
  const [card] = await describeActions(repos, [action({ tool: 'import_tickets', args: { project_id: 'p1', ticket_ids: ids } })], OWNER);
  expect(card.summary.startsWith('importar 12 tickets para o backlog: EI-1, EI-2, EI-3, EI-4, EI-5, EI-6, EI-7, EI-8, EI-9, EI-10 e mais 2')).toBe(true);
});

it('a foreign or gone ticket id in ticket_ids simply does not resolve, never leaking it, while the count still reflects what was asked', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'import_tickets', args: { project_id: 'p1', ticket_ids: ['ticket-1', 'nope'] } })], OWNER);
  expect(card.summary.startsWith('importar 2 tickets para o backlog: EI-1')).toBe(true);
  expect(card.summary).not.toContain('nope');
});

it('push_ticket_status names the ticket, its provider, the target state and the card', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'push_ticket_status', args: { task_id: 'tk2' } })], OWNER);
  expect(card.summary).toContain('mudar o EI-1 no Linear para "Fazendo" (como a tarefa REA-8 "Ajustar layout")');
});

it('push_ticket_status on a card without a ticket link names the card plainly', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'push_ticket_status', args: { task_id: 'tk1' } })], OWNER);
  expect(card.summary).toContain('atualizar o ticket da tarefa');
});

it('push_ticket_status on a task that no longer exists says so plainly, rather than a bare id', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'push_ticket_status', args: { task_id: 'gone' } })], OWNER);
  expect(card.summary).toBe('atualizar o ticket de uma tarefa que não existe mais');
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

// The card's origin (spec 2026-09-26 §4): which subagent's turn proposed the action, resolved the
// same batched, scoped way as every other reference this view names.

it('resolves the subagent that proposed an action', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ subagent_id: subagent.id })], OWNER);
  expect(card.subagent).toEqual({ id: 'sub1', description: 'Escrever testes' });
});

it('resolves no subagent when the row belongs to another conversation, never leaking its description', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ conversation_id: 'c1', subagent_id: otherConversationSubagent.id })], OWNER);
  expect(card.subagent).toBeNull();
});

it('never calls chatSubagents.listByIds when no action names one', async () => {
  const repos = fakeRepos();
  await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'a' }, tab_id: 't1' })], OWNER);
  expect(repos.chatSubagents.listByIds).not.toHaveBeenCalled();
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
    kind: 'tab', id: 'g1', tab_id: tab.id, tool: 'send_input', source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    tab_name: tab.name, project_id: project.id, project_name: project.name, conversation_id: 'c1', conversation_project_name: project.name,
    conversation_archived: false, state: 'active', ended_at: null, scope: null, standing_kind: null,
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

const projectGrant = (over: Partial<ChatProjectGrant>): ChatProjectGrant => ({
  id: 'pg1',
  conversation_id: 'c1',
  project_id: 'p1',
  scope: 'board',
  source_action_id: 'a1',
  granted_by: OWNER,
  created_at: '2026-09-25T10:00:00.000Z',
  expires_at: '2026-09-26T10:00:00.000Z',
  revoked_at: null,
  revoked_by: null,
  ...over,
});

it('describeProjectGrants names the grant\'s project, dropping every user id', async () => {
  const repos = fakeRepos();
  const [view] = await describeProjectGrants(repos, [projectGrant({ project_id: project.id })], OWNER);
  expect(view).toEqual({ id: 'pg1', project_id: project.id, project_name: project.name, source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z', scope: 'board' });
});

it('describeProjectGrants carries an "all" grant\'s scope (TER-325)', async () => {
  const [view] = await describeProjectGrants(fakeRepos(), [projectGrant({ project_id: project.id, scope: 'all' })], OWNER);
  expect(view.scope).toBe('all');
});

it('describeProjectGrants says the project does not exist for a gone or foreign project, never leaking its name', async () => {
  const repos = fakeRepos();
  const [view] = await describeProjectGrants(repos, [projectGrant({ project_id: foreignProject.id })], OWNER);
  expect(view.project_name).toBeNull();
  expect(JSON.stringify(view)).not.toContain(foreignProject.name);
});

it('describeProjectGrants batches: one lookup for the whole list, deduped, and none at all for an empty list', async () => {
  const repos = fakeRepos();
  await describeProjectGrants(repos, [projectGrant({ id: 'pg1', project_id: project.id }), projectGrant({ id: 'pg2', project_id: project.id })], OWNER);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledWith([project.id], OWNER);

  const empty = fakeRepos();
  expect(await describeProjectGrants(empty, [], OWNER)).toEqual([]);
  expect(empty.projects.findByIdsForOwner).not.toHaveBeenCalled();
});

const listedProject = (over: Partial<ChatProjectGrantWithConversation>): ChatProjectGrantWithConversation => ({ ...projectGrant({}), conversation_project_id: null, conversation_archived: false, ...over });

it('describeProjectGrantList names the project and the origin conversation, with state and ended_at — no tab, ever', async () => {
  const repos = fakeRepos();
  const [active, revoked, expiredThenReset] = await describeProjectGrantList(
    repos,
    [
      listedProject({ id: 'pg1', project_id: project.id, conversation_project_id: project.id }),
      listedProject({ id: 'pg2', project_id: project.id, revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: OWNER, conversation_archived: true }),
      listedProject({ id: 'pg3', project_id: foreignProject.id, expires_at: '2026-09-25T09:00:00.000Z', revoked_at: '2026-09-25T11:00:00.000Z', revoked_by: null }),
    ],
    OWNER,
    NOW,
  );
  expect(active).toEqual({
    kind: 'project', id: 'pg1', tab_id: null, tool: null, tab_name: null, source_action_id: 'a1', created_at: '2026-09-25T10:00:00.000Z', expires_at: '2026-09-26T10:00:00.000Z',
    project_id: project.id, project_name: project.name, conversation_id: 'c1', conversation_project_name: project.name,
    conversation_archived: false, state: 'active', ended_at: null, scope: 'board', standing_kind: null,
  });
  expect(revoked).toMatchObject({ state: 'revoked', ended_at: '2026-09-25T11:00:00.000Z', conversation_project_name: null, conversation_archived: true, tab_id: null, tab_name: null, tool: null });
  // A gone or foreign project: project_name (and the derived conversation_project_name) never leak it —
  // exactly like describeGrantList above — while the state rule (expired before a later reset) still holds.
  expect(expiredThenReset).toMatchObject({ state: 'expired', ended_at: '2026-09-25T09:00:00.000Z', project_id: foreignProject.id, project_name: null });
  expect(JSON.stringify(expiredThenReset)).not.toContain(foreignProject.name);
});

it('describeProjectGrantList carries each grant\'s scope (TER-325)', async () => {
  const [all] = await describeProjectGrantList(fakeRepos(), [listedProject({ id: 'pg1', project_id: project.id, scope: 'all' })], OWNER, NOW);
  expect(all.scope).toBe('all');
});

it('describeProjectGrantList batches one lookup for both the grant\'s and the conversation\'s projects, owner-scoped, and none for an empty list', async () => {
  const repos = fakeRepos();
  await describeProjectGrantList(repos, [listedProject({ id: 'pg1', project_id: project.id, conversation_project_id: project.id }), listedProject({ id: 'pg2', project_id: project.id })], OWNER, NOW);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledTimes(1);
  expect(repos.projects.findByIdsForOwner).toHaveBeenCalledWith([project.id], OWNER);
  const empty = fakeRepos();
  expect(await describeProjectGrantList(empty, [], OWNER, NOW)).toEqual([]);
  expect(empty.projects.findByIdsForOwner).not.toHaveBeenCalled();
});

// create_integration and set_project_repo (spec 2026-09-28 MCP integrations D6) are irreversible: the
// card is the only thing the person sees before a credential is stored or the CI repository changes.
const ghArgs = (machine_id: string) => ({ provider: 'github', name: 'GitHub pessoal', secret_from: { machine_id, source: 'gh_auth_token' } });

it('create_integration names the integration and the machine whose gh login it reads', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'create_integration', args: ghArgs('m1'), class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('criar a integração do GitHub "GitHub pessoal" com o login do gh (`gh auth token`) no macbook m3');
});

it("create_integration never names another owner's machine", async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'create_integration', args: ghArgs('m9'), class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('criar a integração do GitHub "GitHub pessoal" com o login do gh (`gh auth token`) numa máquina que não existe mais');
  expect(card.summary).not.toContain('Máquina Alheia');
});

it('set_project_repo names the repository, the integration, the deploy workflow and the project', async () => {
  const repos = fakeRepos();
  const args = { project_id: 'p1', integration_id: 'g1', full_name: 'acme/api', deploy_workflow: 'deploy.yml', base_branch: 'develop' };
  const [card] = await describeActions(repos, [action({ tool: 'set_project_repo', args, project_id: 'p1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('usar o repositório `acme/api` pela integração "GitHub ana", com o deploy no workflow `deploy.yml`, branch base `develop` no projeto reactivando');
  expect(repos.integrations.list).toHaveBeenCalledWith(OWNER);
});

it("set_project_repo says when deploy is cleared, and never names another owner's integration", async () => {
  const repos = fakeRepos();
  const args = { project_id: 'p1', integration_id: 'g9', full_name: 'acme/api', deploy_workflow: null };
  const [card] = await describeActions(repos, [action({ tool: 'set_project_repo', args, project_id: 'p1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('usar o repositório `acme/api` por uma integração que não existe mais, sem workflow de deploy no projeto reactivando');
  expect(card.summary).not.toContain('Integração Alheia');
});

// automation_merge (agentic board D7): the merge executor's own card for a PR above the project's level.
it('automation_merge names the PR, the repository, why it asks and the project', async () => {
  const repos = fakeRepos();
  const args = { project_id: 'p1', repo: 'acme/api', number: 7, head_sha: 'h1', title: 'Board: drag cards', url: 'u', base: 'main', needed: 'deploy' };
  const [card] = await describeActions(repos, [action({ tool: 'automation_merge', args, project_id: 'p1', class: 'irreversible' })], OWNER);
  expect(card.summary).toBe('mesclar o PR #7 "Board: drag cards" de `acme/api` (precisa do nível Deploy) no projeto reactivando');
  const [store] = await describeActions(repos, [action({ tool: 'automation_merge', args: { ...args, needed: 'store' }, project_id: 'p1', class: 'irreversible' })], OWNER);
  expect(store.summary).toContain('(precisa de build nas lojas)');
});

it('looks up integrations only when a set_project_repo card needs one', async () => {
  const repos = fakeRepos();
  await describeActions(repos, [action({ tool: 'send_input', args: { tab_id: 't1', text: 'x' }, tab_id: 't1' })], OWNER);
  expect(repos.integrations.list).not.toHaveBeenCalled();
});

// "Liberar sem prazo" (spec 2026-09-28 TER-386): no expiry, no tab, not conversation-bound.
const standing = (over: Partial<ChatStandingGrantWithConversation>): ChatStandingGrantWithConversation => ({
  id: 'sg1', user_id: OWNER, project_id: project.id, kind: 'close_tab', conversation_id: 'c1', source_action_id: 'a1',
  created_at: '2026-09-28T10:00:00.000Z', revoked_at: null, revoked_by: null, conversation_project_id: null, conversation_archived: false, ...over,
});

it('describeStandingGrants names the project owner-scoped and carries the kind — no user ids', async () => {
  const [mine, foreign] = await describeStandingGrants(fakeRepos(), [standing({}), standing({ id: 'sg2', project_id: foreignProject.id, kind: 'board', source_action_id: null })], OWNER);
  expect(mine).toEqual({ id: 'sg1', project_id: project.id, project_name: project.name, kind: 'close_tab', source_action_id: 'a1', created_at: '2026-09-28T10:00:00.000Z' });
  expect(foreign).toEqual({ id: 'sg2', project_id: foreignProject.id, project_name: null, kind: 'board', source_action_id: null, created_at: '2026-09-28T10:00:00.000Z' });
});

it('describeStandingGrantList: kind standing, no tab, no expiry, no scope; active or revoked; a gone conversation stays null', async () => {
  const [active, revoked, orphan] = await describeStandingGrantList(
    fakeRepos(),
    [
      standing({ conversation_project_id: project.id }),
      standing({ id: 'sg2', kind: 'terminal', revoked_at: '2026-09-28T11:00:00.000Z', revoked_by: OWNER, conversation_archived: true }),
      standing({ id: 'sg3', project_id: foreignProject.id, kind: 'open_tab', conversation_id: null }),
    ],
    OWNER,
  );
  expect(active).toEqual({
    kind: 'standing', id: 'sg1', tab_id: null, tool: null, tab_name: null, source_action_id: 'a1', created_at: '2026-09-28T10:00:00.000Z', expires_at: null,
    project_id: project.id, project_name: project.name, conversation_id: 'c1', conversation_project_name: project.name,
    conversation_archived: false, state: 'active', ended_at: null, scope: null, standing_kind: 'close_tab',
  });
  expect(revoked).toMatchObject({ state: 'revoked', ended_at: '2026-09-28T11:00:00.000Z', standing_kind: 'terminal', conversation_archived: true, expires_at: null });
  expect(orphan).toMatchObject({ conversation_id: null, conversation_project_name: null, project_name: null, standing_kind: 'open_tab' });
  expect(JSON.stringify(orphan)).not.toContain(foreignProject.name);
});

it('tab and project list rows carry standing_kind: null', async () => {
  const [p] = await describeProjectGrantList(fakeRepos(), [listedProject({ id: 'pg1', project_id: project.id })], OWNER, NOW);
  expect(p.standing_kind).toBeNull();
});

// TER-641: a send the concierge made on a precedent cites its refs; the card resolves the decisions.
it('resolves a send_input\'s cited decisions into auto_decision, owner-scoped; a send that cites none has null', async () => {
  const repos = fakeRepos();
  const cards = await describeActions(
    repos,
    [
      action({ id: 'a1', args: { tab_id: 't1', text: '1', sources: ['decision:d1', 'decision:d9', 'task:tk1'], reason: 'Mesma pergunta de ontem' }, tab_id: 't1', status: 'executed', grant_id: 'default:terminal:u1' }),
      action({ id: 'a2', tool: 'send_key', args: { tab_id: 't1', key: 'Enter', sources: ['decision:d1'] }, tab_id: 't1' }),
      action({ id: 'a3', args: { tab_id: 't1', text: 'oi' }, tab_id: 't1' }),
      action({ id: 'a4', tool: 'create_task', args: { project_id: 'p1', title: 'x', sources: ['decision:d1'] }, project_id: 'p1' }),
    ],
    OWNER,
  );
  expect(cards[0]!.auto_decision).toEqual({
    reason: 'Mesma pergunta de ontem',
    sources: [
      { ref: 'decision:d1', question: 'Rodo os testes?', answer: 'Sim' },
      { ref: 'decision:d9', question: null, answer: null },
      { ref: 'task:tk1', question: null, answer: null },
    ],
  });
  expect(cards[1]!.auto_decision).toEqual({ reason: null, sources: [{ ref: 'decision:d1', question: 'Rodo os testes?', answer: 'Sim' }] });
  expect(cards[2]!.auto_decision).toBeNull();
  expect(cards[3]!.auto_decision).toBeNull(); // only send_input/send_key carry a precedent
  expect((repos as { chatDecisions: { findManyForUser: { mock: { calls: unknown[] } } } }).chatDecisions.findManyForUser.mock.calls).toHaveLength(1);
});

it('never resolves another owner\'s decision on a card', async () => {
  const [card] = await describeActions(fakeRepos(), [action({ args: { tab_id: 't1', text: '1', sources: ['decision:d1'] }, tab_id: 't1' })], OTHER_OWNER);
  expect(card!.auto_decision).toEqual({ reason: null, sources: [{ ref: 'decision:d1', question: null, answer: null }] });
});

it('reads nothing from memory when no card cites a precedent', async () => {
  const repos = fakeRepos();
  await describeActions(repos, [action({ args: { tab_id: 't1', text: 'oi', sources: 'decision:d1' }, tab_id: 't1' })], OWNER);
  expect((repos as { chatDecisions: { findManyForUser: { mock: { calls: unknown[] } } } }).chatDecisions.findManyForUser.mock.calls).toHaveLength(0);
});

it('spells out what a set_automation_policy card turns on or widens, with the level by its Setup name (TER-975)', async () => {
  const repos = fakeRepos();
  const on = action({ tool: 'set_automation_policy', args: { project_id: 'p1', enabled: true, autonomy: 'deploy', max_parallel: 2 }, project_id: 'p1' });
  const paths = action({ tool: 'set_automation_policy', args: { project_id: 'p1', release_paths: ['apps/agent/package.json'], required_checks: [], max_parallel: null }, project_id: 'p1' });
  const [a, b] = await describeActions(repos, [on, paths], OWNER);
  expect(a.summary).toBe('ligar o trabalho automático do projeto; nível "Deploy"; máximo em paralelo: 2 no projeto reactivando');
  expect(b.summary).toBe('mudar o Setup do trabalho automático (caminhos de release: `apps/agent/package.json`; checks obrigatórios: nenhum; máximo em paralelo: sem limite) no projeto reactivando');
});

it('names the machine on a set_machine_automation card (TER-975)', async () => {
  const repos = fakeRepos();
  const [card] = await describeActions(repos, [action({ tool: 'set_machine_automation', args: { machine_id: 'm1', accept: true }, machine_id: 'm1' })], OWNER);
  expect(card.summary).toBe('fazer a máquina aceitar trabalho automático no macbook m3');
});
