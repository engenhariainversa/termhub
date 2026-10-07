import { CAPABILITY_CLAUDE } from '@termhub/agent-protocol';
import { projectAccountsOn } from '../ai/project-accounts.js';
import { loginOf, usableIn } from '../ai/exclusive.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AiAccount, Machine, User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { msg } from '../i18n/index.js';

/**
 * The slice of the agent registry this reads: what the machine's agent said when it connected, or
 * `null` when nobody is connected from it (see `AgentRegistry.capabilities`). Note these are the
 * *protocol* capabilities from `hello`, not `Machine.capabilities` — which is the list of tools the
 * status detection found on the machine and says nothing about what its agent understands.
 */
export interface HostAgents {
  capabilities(machineId: string): string[] | null;
  info(machineId: string): { agent_version: string } | null;
  /** Waits a little for a machine's agent that is moving between instances (a deploy, spec §5.3)
   *  before `capabilities` is read; `AgentRegistry.awaitAgent` in production. */
  awaitAgent(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>): Promise<boolean>;
  /** The same wait, only for an agent this instance never held: what a read for the screen may afford
   *  (`AgentRegistry.awaitHandover`). */
  awaitHandover(machine: Pick<Machine, 'id' | 'type' | 'agent_last_seen_at'>): Promise<boolean>;
}

/** Everything `resolveHost` needs, so it can be exercised without a server: the owner-scoped reads
 *  and the live registry, both as narrow interfaces. */
export interface HostContext {
  repos: Pick<Repositories, 'chat' | 'machines' | 'aiAccounts'> & Partial<Pick<Repositories, 'projectSetup' | 'projectMachines'>>;
  agents: HostAgents;
}

/**
 * Which Claude login on the host the conversation runs on, in the words the screen needs — the second
 * half of the pair, next to `configDir`, which is the same answer in the words the runner needs.
 *
 * `lost` is the one that had to be a state instead of a null: an account the user chose that cannot be
 * used here (deleted, left behind on another machine by a host change, or not a Claude login) silently
 * degrades the run to the machine's own default login. That is the right thing to run, and the wrong
 * thing to do quietly — so it is told apart from `default`, where nothing was ever chosen and there is
 * nothing to say.
 *
 * `via: 'project'` (TER-589): the account comes from the project's list, not from the person's pick. Still
 * `chosen` on the wire: an installed phone app parses `kind` strictly, and ignores the extra field.
 */
export type HostAccount = { kind: 'chosen'; id: string; label: string; via?: 'project' } | { kind: 'default' } | { kind: 'lost' };

/**
 * Which machine and which account run this user's conversation — the "terminal geral" of spec §3 —
 * or why none can. Every variant carries what its message needs (the machine's name, the machines to
 * choose between, the agent's version), because the person must read what actually happened and not a
 * generic failure; Task 6 renders them.
 */
export type HostChoice =
  /**
   * `sessionAtStake` means the same thing here as on `not_chosen`, on the path where nobody is asked
   * anything: this conversation holds a `cli_session_id` and no longer names the machine that session
   * lives in, so the single remaining candidate was auto-picked and the next message will resume a
   * session that host has never seen — it fails, the server restarts on a fresh one, and the model's
   * memory is gone. Right to pick it (there is nothing else to run on), wrong to do it in silence: with
   * three machines the very same deletion produces `not_chosen` and its warning, and the person should
   * not hear less because they had two. A run pins the host it used (`pinHostMachine`), which is what
   * keeps this false for the ordinary single-machine conversation that never chose anything.
   */
  | { kind: 'ready'; machine: Machine; configDir: string | null; account: HostAccount; sessionAtStake: boolean; model?: string | null }
  | { kind: 'no_machine' }
  /**
   * `sessionAtStake` is what tells the two ways of reaching this apart, because they deserve different
   * screens: a conversation that never ran has nothing to lose by picking a machine, while one that
   * already ran holds a `cli_session_id` in the config dir of a machine this conversation no longer
   * names (unenrolled, or never stored because there was only one candidate at the time). Picking a
   * machine that is not the one holding that session throws the model's memory away, and `setHost`
   * cannot see it coming — the stored machine is already null, so it has nothing to compare and keeps
   * the id. Spec §3 says the person hears that before the change, so the state travels instead of
   * being guessed in the browser. Only ever true when something really is at stake: a warning that is
   * usually false teaches people to click past the one that matters.
   */
  | { kind: 'not_chosen'; machines: Machine[]; sessionAtStake: boolean }
  | { kind: 'offline'; machine: Machine }
  | { kind: 'agent_too_old'; machine: Machine; version: string };

/** Anything but a host that can run right now. */
export type HostProblem = Exclude<HostChoice, { kind: 'ready' }>;

/**
 * Resolves the host pair for this user's conversation — always the account-wide row's, which a project
 * chat shares (spec 2026-09-23 §3): `requires` is how a project chat asks for the one extra capability
 * it needs, on the same host, and `runSessionId` is the session of the conversation that will run,
 * which is what `sessionAtStake` is about (spec §4.2). It reads and never writes: a stale choice is
 * reported as "choose again", never silently rewritten, so two runs racing cannot disagree about
 * which machine answered.
 *
 * The candidates are the user's **own agent machines**: only an agent holds the connection a run
 * travels on (a local machine is the server's own computer, an ssh machine has no agent), and the
 * list is owner-scoped in SQL, so a chosen id that belongs to someone else is simply not in it. That
 * is what makes `ready` unreachable for a machine the user does not own.
 */
export async function resolveHost(
  ctx: HostContext,
  user: User,
  opts: { requires?: string; runSessionId?: string | null; wait?: boolean | 'handover'; project?: { id: string; accountId: string | null } } = {},
): Promise<HostChoice> {
  const [conversation, machines] = await Promise.all([ctx.repos.chat.getOrCreateForUser(user.id), ctx.repos.machines.list(user.id)]);
  const candidates = machines.filter((m) => m.type === 'agent');
  if (candidates.length === 0) return { kind: 'no_machine' };

  const chosen = conversation.machine_id === null ? undefined : candidates.find((m) => m.id === conversation.machine_id);
  // Whether a session is at stake is the same question on both paths, and it has one answer: this
  // conversation ran, and the machine it names is not one it can run on now (unenrolled, handed over,
  // or — for a host a run pinned — nulled by the foreign key). Whatever happens next, the session that
  // holds the model's memory is not on the machine that will answer.
  //
  // The session is the *run* conversation's (spec §4.2): the account-wide row owns the host, but a
  // project chat's memory is its own session, which the account-wide row's says nothing about. Absent
  // (`undefined`), the run conversation is the account-wide one itself.
  const runSessionId = opts.runSessionId !== undefined ? opts.runSessionId : conversation.cli_session_id;
  const sessionAtStake = chosen === undefined && runSessionId !== null;
  // A chosen machine that is gone (deleted, or no longer this user's) behaves exactly as if nothing
  // had ever been chosen: with one machine there is nothing to ask, with several the user picks.
  const machine = chosen ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!machine) return { kind: 'not_chosen', machines: candidates, sessionAtStake };

  // A host moving between instances (a deploy) gets a few seconds before a message about to be sent
  // is answered "offline". Only such a caller waits (`wait`): a read of the screen, or a sweep over
  // many rows, answers with what is connected now instead of stalling on a laptop that went to sleep.
  // The screen still waits for a `handover`: on a colour that just started the browser arrives before
  // the agent does, and an "offline" read then stays on screen until the next one.
  if (opts.wait === 'handover') await ctx.agents.awaitHandover(machine);
  else if (opts.wait) await ctx.agents.awaitAgent(machine);
  const capabilities = ctx.agents.capabilities(machine.id);
  // Offline, or connected but still before `hello`: the same thing to a message that has to be sent
  // now. Never a fallback to the operator's container (spec §3) — that would spend the operator's
  // credit with nobody watching and hide that the user's machine was not involved.
  if (capabilities === null) return { kind: 'offline', machine };
  // The same capability `agentRunner` requires before it opens a channel; checked here so the person
  // reads one sentence *before* a run is attempted, instead of a failed answer afterwards.
  if (!capabilities.includes(CAPABILITY_CLAUDE)) {
    // The version comes from the live `hello` (an agent that is connected always has one); the stored
    // one is the fallback, and an empty string means the agent never said — the message then drops
    // the version rather than inventing one.
    return { kind: 'agent_too_old', machine, version: ctx.agents.info(machine.id)?.agent_version ?? machine.agent_version ?? '' };
  }
  // A project chat needs more of the agent than the account-wide chat does (spec §4.3): an agent that
  // does not forward the project's prompt would run the chat unfocused without saying so.
  if (opts.requires && !capabilities.includes(opts.requires)) {
    return { kind: 'agent_too_old', machine, version: ctx.agents.info(machine.id)?.agent_version ?? machine.agent_version ?? '' };
  }

  if (opts.project && ctx.repos.projectSetup && ctx.repos.projectMachines) {
    const { ai, listed } = await projectAccountsOn({ ...ctx.repos, projectSetup: ctx.repos.projectSetup, projectMachines: ctx.repos.projectMachines }, opts.project.id, user.id, machine.id, 'claude');
    const model = ai.models.claude;
    if (listed.length > 0) {
      // The project's account (spec 2026-09-30 project AI accounts §7.1): the one this project chat last
      // answered on while it is still listed, else the first in the project's order. The person's own
      // pick on the account-wide row keeps ruling every other chat.
      const sticky = listed.find((a) => a.id === opts.project!.accountId) ?? listed[0];
      return { kind: 'ready', machine, sessionAtStake, configDir: sticky.config_dir, account: { kind: 'chosen', id: sticky.id, label: sticky.label, via: 'project' }, model };
    }
    return { kind: 'ready', machine, sessionAtStake, ...(await accountFor(ctx, conversation.ai_account_id, machine)), model };
  }
  return { kind: 'ready', machine, sessionAtStake, ...(await accountFor(ctx, conversation.ai_account_id, machine)) };
}

/**
 * The login the run uses: the `CLAUDE_CONFIG_DIR` it gets (`null` = the machine's own default login),
 * and which account that is.
 *
 * The machine's default login is the answer to every doubt, never a failure: the account row was
 * deleted (the column is `ON DELETE SET NULL`, but a read can also race the delete), it belongs to
 * another machine (left behind by a host change, so its path names a directory that on this host is
 * absent or someone else's login), or it is not a Claude account at all. Guessing another of the
 * machine's accounts would run the conversation on a login the user did not pick. Every one of those
 * comes back as `lost`, so the screen can say the chosen account is not the one running — the silent
 * half of this fallback was the whole complaint.
 */
async function accountFor(ctx: HostContext, accountId: string | null, machine: Machine): Promise<{ configDir: string | null; account: HostAccount }> {
  if (accountId === null) return { configDir: null, account: { kind: 'default' } };
  const account = await ctx.repos.aiAccounts.findById(accountId);
  if (!account || account.machine_id !== machine.id || account.provider !== 'claude') return { configDir: null, account: { kind: 'lost' } };
  // A Claude account of this machine with no config dir is the machine's default login, chosen on
  // purpose: still the account the user picked, so never `lost`.
  return { configDir: account.config_dir, account: { kind: 'chosen', id: account.id, label: account.label } };
}

/**
 * `(versão 0.4.9)`, or nothing at all when the agent never said which one it is.
 *
 * Deliberately duplicated in `apps/web/src/components/chat/ChatHost.tsx`, which renders the same note
 * in the browser: this is one string on either side of a process boundary, and a shared package for it
 * would cost more than it saves. If the shape of the note changes, change both — they are not wired
 * together and nothing will fail if one is forgotten.
 */
/**
 * What a host that cannot run says to the person who just sent a message. Thrown before any
 * assistant row is written, so the browser shows this sentence instead of an empty bubble waiting for
 * an answer nobody is producing; the code is what the screen keys its own, longer explanation and its
 * button off (Task 6).
 *
 * 409, not 503: none of these is the server being unavailable — each is a state of the user's own
 * account that retrying does not change and that they can act on.
 */
export function hostFailure(problem: HostProblem): HttpError {
  switch (problem.kind) {
    case 'no_machine':
      return new HttpError(409, 'O chat roda em uma máquina sua. Cadastre uma máquina com o agente do termhub para conversar com o concierge.', 'CHAT_NO_MACHINE');
    case 'not_chosen':
      return new HttpError(409, 'Escolha em qual das suas máquinas o chat vai rodar.', 'CHAT_HOST_NOT_CHOSEN');
    case 'offline':
      return new HttpError(409, msg('A máquina {{name}} está offline. Ligue-a ou escolha outra máquina para o chat.', { name: problem.machine.name }), 'CHAT_HOST_OFFLINE');
    case 'agent_too_old':
      return new HttpError(
        409,
        problem.version
          ? msg('O agente da máquina {{name}} (versão {{version}}) ainda não sabe rodar o chat. Atualize o agente e tente de novo.', { name: problem.machine.name, version: problem.version })
          : msg('O agente da máquina {{name}} ainda não sabe rodar o chat. Atualize o agente e tente de novo.', { name: problem.machine.name }),
        'CHAT_AGENT_TOO_OLD',
      );
  }
}

/**
 * TER-990: the account a ready host would run this conversation on (the chosen one, else the machine's
 * default login), when it is exclusive to a project other than the conversation's (`null`: the
 * account-wide chat, which no exclusive account serves). null when the run may go on.
 */
export async function exclusiveConflict(repos: Pick<Repositories, 'aiAccounts'>, user: Pick<User, 'id'>, host: Extract<HostChoice, { kind: 'ready' }>, projectId: string | null): Promise<AiAccount | null> {
  // the host is one of the user's own machines (`resolveHost`), so their accounts are the machine's
  const accounts = await repos.aiAccounts.list(user.id);
  const login = loginOf(accounts, host.machine.id, 'claude', host.account.kind === 'chosen' ? host.account.id : null);
  return login && !usableIn(login, projectId) ? login : null;
}
