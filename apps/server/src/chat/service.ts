import { randomUUID } from 'node:crypto';
import { CAPABILITY_CLAUDE_SYSTEM_PROMPT } from '@termhub/agent-protocol';
import type { Repositories } from '../db/repositories/index.js';
import type { ChatConversation, ChatMessage } from '../db/repositories/chat.js';
import type { ChatAction } from '../db/repositories/chat-actions.js';
import { describeActions } from '../db/repositories/chat-actions-view.js';
import type { User } from '../db/repositories/types.js';
import { HttpError } from '../lib/errors.js';
import { chatBus } from './bus.js';
import { hostFailure, resolveHost, type HostAgents, type HostChoice } from './host.js';
import { projectSystemPrompt } from './project-prompt.js';
import { parseFrame, type ChatFailureReason } from './stream.js';
import { mintConciergeToken } from './token.js';

/**
 * What a stored failure says. Every label a runner can end a run with becomes a code of its own —
 * `Uppercase<ChatFailureReason>`, derived from the one list in `stream.ts`, so a new reason reaches
 * the row (and the screen) without anyone remembering to extend a mapping here. CLI_REJECTED is our
 * own flags being refused, MISSING_SESSION a session the account no longer has, CLI_MISSING a machine
 * with no `claude` installed, HOST_GONE the machine going away mid-run. The two that are not a
 * runner's label: TOKEN_FAILED (the server could not even mint a credential) and RUNNER_FAILED (the
 * stream ended with nothing said about why).
 */
export type ChatErrorCode = 'TOKEN_FAILED' | 'RUNNER_FAILED' | Uppercase<ChatFailureReason> | null;

const codeForReason = (reason?: ChatFailureReason): ChatErrorCode => (reason ? (reason.toUpperCase() as Uppercase<ChatFailureReason>) : 'RUNNER_FAILED');

export interface RunnerInput {
  session_id: string;
  resume: boolean;
  text: string;
  /** The account the run uses: a `CLAUDE_CONFIG_DIR` on the host machine, or `null` for that
   *  machine's own default login (an `ai_account` row with no `config_dir`). */
  config_dir: string | null;
  model?: string | null;
  token: string;
  /** Project chats only: the server-composed focus text (spec §4.3). Absent for the account-wide chat. */
  append_system_prompt?: string | null;
}
/** A run that has started: both messages are stored and published; `done` settles when it ends. */
export interface StartedRun {
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string;
  done: Promise<ChatMessage>;
}
export interface RunnerClient {
  run(input: RunnerInput): AsyncIterable<string>;
}

/** How long a proposed action waits for the user's decision before it is nobody's question anymore —
 * and, since an approval nobody consumed is just as stale, how long a "yes" stays good (the gate reads
 * this same constant for `APPROVAL_HOLDS_MS`). Kept in step with `mintConciergeToken`'s own TTL_MS: a
 * token outlives every action minted under it. */
export const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The hourly timer's other half (app.ts, next to `authService.purgeExpired()`): an open row must not
 * sit open forever — it would keep blocking the same proposal's idempotency key and keep showing as an
 * open question on every reload. Both ways of being open age out, each from its own clock: a question
 * the user never answered from when it was asked, an approval no run ever came back to consume from
 * when it was given (see `expireOlderThan`). An approval that is merely slow to be re-injected is well
 * inside the window; one still here a day later is one nobody will ever use, and the gate would
 * otherwise honour it indefinitely.
 *
 * A standalone function, not a `ChatService` method: it only ever needs `repos`, and keeping it out of
 * the class means the hourly timer can call it without constructing a runner or config dirs it has no
 * use for, and it can be unit-tested the same way.
 */
export async function purgeExpiredActions(repos: Repositories, now = new Date()): Promise<number> {
  return repos.chatActions.expireOlderThan(new Date(now.getTime() - ACTION_TTL_MS));
}

/**
 * What a failure is called, never what it says. Our own errors (`HttpError`, `ControlError`) and the
 * database driver's carry a `code`; anything else is named by its class. A message is deliberately out
 * of reach: a rejected write carries the rejected data, so logging one would put the injected sentence
 * or the proposed command in a log line — the one thing that must never be logged (spec §7.1).
 */
export const failureLabel = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.name : typeof err;
};

/**
 * Errors that mean "the chat could not even be attempted" rather than "the answer failed": the
 * concierge is not configured on this server (503) or did not accept the request at all (502).
 * They escape `send()` so the route answers with that status and its pt-BR message, instead of
 * every message forever being stored as a run that died — retrying a missing configuration never
 * helps, and the page has nothing to say about it.
 */
const isSetupFailure = (e: unknown): e is HttpError =>
  e instanceof HttpError && (e.code === 'CONCIERGE_DISABLED' || e.code === 'CONCIERGE_FAILED');

/** What the action targets, in the one line the model needs to tell this proposal apart from any
 * other it may have made — the tool name and the target ids the model's own original call carried
 * (`args.tab_id`/`project_id`/`machine_id`, capped and id-shaped by the gate before they were ever
 * stored — see `targetOf` in gate-runtime.ts), never a tool result and never free-form argument text. */
const targetDescription = (action: ChatAction): string => {
  if (action.tab_id) return `aba ${action.tab_id}`;
  if (action.project_id) return `projeto ${action.project_id}`;
  if (action.machine_id) return `máquina ${action.machine_id}`;
  return 'sem alvo específico';
};

/**
 * The re-injection (spec §5, Task 5): a fixed pt-BR sentence the server composes — the tool name, the
 * target ids and, on a fresh session, the approved proposal itself; never a tool result — so the model
 * can re-issue the exact call that was gated (an approval) or drop it for good (a denial), without
 * being asked to guess which of its proposals the user was answering or to read the user's own words.
 *
 * When no CLI session is alive (Review Focus 2: an approval can arrive an hour later, or the CLI may
 * have dropped the session), `send` already starts a fresh run on its own — this adds the line that
 * tells the user so in the chat, instead of a fresh run happening silently, and the proposal the lost
 * transcript would otherwise have carried (`approvedProposal`).
 */
const injectionText = (action: ChatAction, freshSession: boolean, summary?: string): string => {
  const target = targetDescription(action);
  const sessionNote = freshSession
    ? ' A sessão de trabalho anterior não está mais disponível, então esta é uma nova sessão, sem o histórico da conversa anterior.'
    : '';
  if (action.status === 'denied')
    return `O usuário recusou: ${action.tool} em ${target}.${sessionNote} Não faça essa ação: explique ao usuário o que ficou sem fazer e, se fizer sentido, proponha uma alternativa.`;
  return `O usuário autorizou: ${action.tool} em ${target}.${sessionNote}${freshSession ? approvedProposal(action, summary) : ''} Siga com essa ação.`;
};

/**
 * What the user approved, spelled out — for a fresh session only. Without a transcript, "o usuário
 * autorizou: send_input em aba t1" names the tool and the target and nothing else: the model cannot
 * know *what text to type*, so it either asks again or invents different arguments, which hash to a
 * different idempotency key and raise a second question for an action already authorised, while the
 * approved row it never used lingers.
 *
 * Both halves are the user's own proposal, which §7.1 explicitly permits storing and showing, and
 * neither is a tool result: `summary` is the very sentence the card the user answered showed them, and
 * `args` is the call the concierge itself proposed — the exact bytes the gate hashed, so re-issuing
 * them lands on the approved row instead of opening a new question. A resumed session gets none of
 * this: its transcript already carries the context, and the shorter sentence is the better one there.
 */
const approvedProposal = (action: ChatAction, summary?: string): string =>
  `${summary ? ` A ação autorizada foi: ${summary}.` : ''} Refaça exatamente esta chamada, com estes argumentos e nenhuma alteração: ${JSON.stringify(action.args)}.`;

/** Appended when the approval came with "Permitir sempre nesta aba": the model should stop expecting
 * a question per message to that tab, know it can still be revoked, and know the limits the gate keeps
 * (spec §2 "Agent tabs only"): an agent must be running in the tab, and "!" text or any control
 * character other than a newline is always asked. */
const GRANT_NOTE = ' O usuário também permitiu digitar nesta aba sem confirmar: os próximos send_input nesta aba, nesta conversa, rodam sem pedir confirmação, até ele revogar ou por 24 horas, e só enquanto a aba estiver rodando um agente. Isso não vale para run_command, send_key, para responder permissões, para texto que comece com "!" nem para texto com caracteres de controle.';

export class ChatService {
  /** One run per conversation: two `claude -p` processes on the same --session-id would race. */
  private running = new Set<string>();
  /** Decisions whose `markInjected` failed in this process — see `drainNextDecision`. In memory on
   * purpose: the row itself is untouched, so a restart tries it again with a healthy database. */
  private unmarkable = new Set<string>();

  constructor(
    private deps: {
      repos: Repositories;
      /** The registry `resolveHost` reads: which of the user's machines is connected, and what its
       *  agent understands. */
      agents: HostAgents;
      /** The runner for one host machine — `agentRunner` in production. A function, not a client:
       *  which machine runs a conversation is decided per send, by `resolveHost`. */
      runnerFor: (machineId: string) => RunnerClient;
    },
  ) {}

  /** The active conversation of a scope: the account-wide chat, or one of the user's own projects. A
   * project id that is not this user's is a 404 — never a conversation about someone else's project. */
  async conversationFor(user: User, projectId: string | null = null): Promise<ChatConversation> {
    if (projectId === null) return this.deps.repos.chat.getOrCreateForUser(user.id);
    const [project] = await this.deps.repos.projects.findByIdsForOwner([projectId], user.id);
    if (!project) throw new HttpError(404, 'Projeto não encontrado', 'PROJECT_NOT_FOUND');
    return this.deps.repos.chat.getOrCreateForProject(user.id, projectId);
  }

  /** The host pair for a scope, as the screen shows it (`GET /api/chat`) and as `send` requires it.
   *  One place decides it; nothing here re-derives any part of it. The host is always the account-wide
   *  conversation's (spec 2026-09-23 §3); a project chat additionally needs an agent that forwards its
   *  prompt, so the same machine can be ready for one scope and too old for the other. */
  async hostFor(user: User, projectId: string | null = null): Promise<HostChoice> {
    if (projectId === null) return this.hostForConversation(user, null);
    return this.hostForConversation(user, await this.conversationFor(user, projectId));
  }

  /** The host as seen by one run conversation: the account-wide row's machine and account, the extra
   * capability a project chat needs, and whether *this* conversation's session is at stake (spec §4.2 —
   * the conversation that owns the host is taken separately from the one being run). `null` is the
   * account-wide conversation, whose session `resolveHost` reads itself. */
  private hostForConversation(user: User, conversation: ChatConversation | null): Promise<HostChoice> {
    const ctx = { repos: this.deps.repos, agents: this.deps.agents };
    if (conversation === null || conversation.project_id === null) return resolveHost(ctx, user, conversation === null ? {} : { runSessionId: conversation.cli_session_id });
    return resolveHost(ctx, user, { requires: CAPABILITY_CLAUDE_SYSTEM_PROMPT, runSessionId: conversation.cli_session_id });
  }

  /**
   * "Nova conversa" (spec §4.1): the active conversation of the scope is archived and a fresh one takes
   * its place — a new CLI session, an empty thread. Holds the conversation's lock while it works, so a
   * message cannot start a run on the row being archived. Its open questions are expired and its tokens
   * revoked first: nobody will answer a card in a thread that is no longer on screen, and a token minted
   * for a conversation that is over must not reach the gate on its behalf.
   */
  async reset(user: User, projectId: string | null): Promise<ChatConversation> {
    const current = await this.conversationFor(user, projectId);
    if (this.running.has(current.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    this.running.add(current.id);
    try {
      await this.deps.repos.chatActions.expireOpenForConversation(current.id);
      await this.deps.repos.chatGrants.revokeForConversation(current.id);
      await this.deps.repos.apiTokens.revokeForConversation(current.id);
      await this.deps.repos.chat.archive(current.id);
    } finally {
      this.running.delete(current.id);
    }
    const fresh = await this.conversationFor(user, projectId);
    // The account-wide row owns the host (spec §3): a new thread is not a new machine or account, and
    // every project chat resolves its host from this row, so theirs must not move either. The pair is
    // copied as it was, so nothing moved and no project session is cleared.
    if (projectId === null && current.machine_id !== null) {
      return (await this.deps.repos.chat.setHost(fresh.id, { machine_id: current.machine_id, ai_account_id: current.ai_account_id })).conversation;
    }
    return fresh;
  }

  /** What the sidebar's 💬 shows per project: answering right now, and questions waiting on the user.
   * `busy` is this process's own lock, the same one `send` refuses on — the only truth there is about a
   * run in flight. */
  async projectStatuses(user: User): Promise<{ project_id: string; busy: boolean; pending_confirmations: number }[]> {
    const rows = await this.deps.repos.chat.listActiveProjectConversations(user.id);
    const pending = await this.deps.repos.chatActions.countPendingByConversation(rows.map((r) => r.id));
    return rows.map((r) => ({ project_id: r.project_id, busy: this.running.has(r.id), pending_confirmations: pending.get(r.id) ?? 0 }));
  }

  /**
   * Answers the user's decision on a gated action by re-injecting it into the same CLI session, so
   * the model re-issues the call (an approval, which Task 4's `allow` branch then executes) or drops
   * it (a denial). This is exactly one message: `decide()` already made sure the caller cannot reach
   * here twice for the same row (ruling R9 — the second click of the same decision gets a 409 in the
   * route before this is ever called), so nothing here retries or de-dupes on its own.
   *
   * Runs in the action's own conversation, not whichever scope the caller has open: a card answered
   * from the account-wide screen may belong to a project chat, and the model that proposed it is there.
   *
   * Reuses `sendIn` wholesale rather than duplicating its streaming, retry and locking logic: the
   * injected sentence is just another user turn, so the busy lock, the fresh-session fallback and the
   * bus events all behave exactly as they do for anything the user types.
   *
   * If another run already holds the conversation's lock, `sendIn` throws `HttpError(409, CHAT_BUSY)`
   * before `beforeRun` ever gets to mark the row injected — the decision stays `approved`/`denied`
   * with `injected_at` still null, exactly the state `findNextToInject` looks for. The route (fix
   * round 2) turns that specific 409 into a 200: the decision is already durably recorded, so telling
   * the client "conflict" would be a lie. `drainNextDecision` picks the row up once the busy run's own
   * `send` call releases the lock, so the two paths — inject now, or inject once the lock frees up —
   * both go through this same `beforeRun` marking, and cannot diverge (fix round 2, point 4).
   */
  async resumeAfterDecision(user: User, action: ChatAction): Promise<ChatMessage> {
    const conversation = await this.deps.repos.chat.findByIdForUser(action.conversation_id, user.id);
    // `decide` already proved the row is this user's; a conversation archived since then has nobody
    // reading it, and `reset` expired its open rows — nothing to inject.
    if (!conversation || conversation.archived_at !== null) throw new HttpError(409, 'Esta conversa foi encerrada', 'CHAT_ARCHIVED');
    return this.sendIn(user, conversation, await this.injectionFor(user, action, conversation.cli_session_id === null), {
      beforeRun: () => this.deps.repos.chatActions.markInjected(action.id),
    });
  }

  /**
   * The sentence a decision is injected as. Only a fresh session pays for the enriched summary — three
   * owner-scoped batched reads, resolved by the very function that built the card the user answered
   * (`describeActions`, so a foreign id in the proposal still resolves to nothing here) — because only
   * a fresh session has lost the transcript that would otherwise say what was approved.
   */
  private async injectionFor(user: User, action: ChatAction, freshSession: boolean): Promise<string> {
    if (action.status === 'denied') return injectionText(action, freshSession);
    const grant = await this.deps.repos.chatGrants.findActiveBySourceAction(action.conversation_id, action.id);
    const grantNote = grant ? GRANT_NOTE : '';
    if (!freshSession) return injectionText(action, freshSession) + grantNote;
    const [card] = await describeActions(this.deps.repos, [action], user.id);
    return injectionText(action, freshSession, card.summary) + grantNote;
  }

  /**
   * Picks up exactly one decided-but-uninjected action for this conversation, if any, once a run's
   * lock is released. This is how a decision that lost the race to a busy run in `resumeAfterDecision`
   * still gets injected, without the client that clicked approve/deny ever retrying anything.
   *
   * Injects at most one: the run this starts is itself a `send` call whose own completion calls this
   * again, so a backlog of N decisions drains over N completions, one at a time, in the order they
   * were decided — never by looping over the whole backlog inside a single call (which is the
   * "recursing" the fix round asked to avoid: unbounded depth in one call instead of one step per
   * natural completion).
   *
   * Drains the conversation whose lock was just released, and only it: each conversation (the
   * account-wide one, each project's) has its own lock and its own queue. The conversation is re-read
   * by id and owner, so the injected run uses the caller's own `user` for a row that is provably theirs;
   * one archived in the meantime is left alone — `reset` expired its open rows, and nobody reads it.
   *
   * Never lets a failure here reach its own caller: it is scheduled from a `finally` block, so it must
   * never turn a clean, already-finished run into a thrown error over an unrelated decision's failed
   * retry (a lock grabbed by an unrelated message in the moment between the lookup and the injected
   * `send` call, a concierge outage). It is still swallowed at the call site, and it leaves a trace
   * before it is: a failure between marking a row injected and storing the injected message loses that
   * decision for good, and a loss nobody can find afterwards is exactly the failure this branch spent a
   * round ruling out. The trace is metadata only — the conversation, the action, and the failure's label
   * — never the injected sentence, the arguments, the prompt or the token.
   */
  private async drainNextDecision(user: User, conversationId: string): Promise<void> {
    let actionId: string | null = null;
    try {
      const conversation = await this.deps.repos.chat.findByIdForUser(conversationId, user.id);
      if (!conversation || conversation.archived_at !== null) return;
      const next = await this.deps.repos.chatActions.findNextToInject(conversation.id, [...this.unmarkable]);
      if (!next) return;
      actionId = next.id;
      await this.sendIn(user, conversation, await this.injectionFor(user, next, conversation.cli_session_id === null), {
        // Marking is what makes the injection at-most-once, so a row it failed on stays uninjected and
        // would be picked again by the drain this very failure schedules — a spin on one row for as long
        // as the database keeps refusing. Remembering it here is what stops that; the row is not lost,
        // the next process (or `GET /api/chat`'s trail) still shows the decision the user gave.
        beforeRun: async () => {
          try {
            await this.deps.repos.chatActions.markInjected(next.id);
          } catch (err) {
            this.unmarkable.add(next.id);
            throw err;
          }
        },
      });
    } catch (err) {
      console.error('chat: a decided action could not be re-injected', { conversation_id: conversationId, action_id: actionId, error: failureLabel(err) });
    }
  }

  /** A message the user typed, in the account-wide chat or in one of their projects' (`projectId`).
   * Awaits the whole run: what the web's `POST /api/chat/messages` answers with. */
  async send(user: User, text: string, opts: { projectId?: string | null } = {}): Promise<ChatMessage> {
    return (await this.start(user, text, opts)).done;
  }

  /**
   * The same message as `send`, but resolved as soon as the question and the empty answer are stored
   * and published — for a client that cannot hold a request open for the whole run (the phone app).
   * Everything that refuses the message outright (no host, busy, archived) still rejects this call
   * itself, with nothing stored; what happens afterwards is `done`'s, which rejects exactly when `send`
   * would have thrown (a setup failure). A caller that does not await `done` must attach its own
   * `catch`: this never swallows it, since `send` relies on that rejection.
   */
  async start(user: User, text: string, opts: { projectId?: string | null } = {}): Promise<StartedRun> {
    return this.startIn(user, await this.conversationFor(user, opts.projectId ?? null), text);
  }

  /** The project's focus text for this run, or null for the account-wide chat. Owner-scoped reads, so a
   * machine link to a machine this user no longer owns names nothing. Read per run, never stored: a
   * rename or a new machine link reaches the very next message. */
  private async promptFor(user: User, conversation: ChatConversation): Promise<string | null> {
    if (conversation.project_id === null) return null;
    const [project] = await this.deps.repos.projects.findByIdsForOwner([conversation.project_id], user.id);
    // Never a silent fallback to no prompt: a project chat that runs unfocused is the one failure the
    // capability check exists to rule out.
    if (!project) throw new HttpError(404, 'Projeto não encontrado', 'PROJECT_NOT_FOUND');
    const links = await this.deps.repos.projectMachines.listByProject(project.id);
    const machines = await this.deps.repos.machines.findByIdsForOwner(links.map((l) => l.machine_id), user.id);
    const nameOf = new Map(machines.map((m) => [m.id, m.name]));
    return projectSystemPrompt(project, links.filter((l) => nameOf.has(l.machine_id)).map((l) => ({ machine: nameOf.get(l.machine_id)!, cwd: l.cwd })));
  }

  /** One whole run in a given conversation — what a decision's re-injection and the drain await. */
  private async sendIn(user: User, conversation: ChatConversation, text: string, opts?: { beforeRun?: () => Promise<void> }): Promise<ChatMessage> {
    return (await this.startIn(user, conversation, text, opts)).done;
  }

  /** The first half of a run — what `start`, `send`, a decision's re-injection and the drain share: the
   * checks, the lock and the two stored messages. The rest is `finishRun`'s, started here and handed
   * back as `done`. The conversation's own id is the lock, so a project chat and the account-wide chat
   * run side by side. */
  private async startIn(user: User, conversation: ChatConversation, text: string, opts?: { beforeRun?: () => Promise<void> }): Promise<StartedRun> {
    // Which machine and which account, before the lock is taken and before a single row is written: a
    // host that cannot run is not a failed answer, it is a message that was never sent. Storing the
    // question and an empty assistant bubble for it would leave the screen waiting on an answer nobody
    // is producing, and the person would have to guess why — so this throws, carrying the reason as
    // its code (see `hostFailure`). Deliberately not a fallback to the operator's container (spec §3).
    //
    // Resolved *before* the busy check, not between it and `running.add`: every await in between is a
    // window in which a second message passes the check and starts a second run on the same session.
    const host = await this.hostForConversation(user, conversation);
    if (host.kind !== 'ready') throw hostFailure(host);
    // Read with the host, before the lock and before any row: a read that fails here is a message never
    // sent, not an empty assistant bubble left behind by an error thrown mid-run.
    const appendSystemPrompt = await this.promptFor(user, conversation);
    if (this.running.has(conversation.id)) throw new HttpError(409, 'O concierge ainda está respondendo a mensagem anterior', 'CHAT_BUSY');
    const runner = this.deps.runnerFor(host.machine.id);
    this.running.add(conversation.id);
    let handedOff = false;
    try {
      // Re-read under the lock: `conversation` was read before the host and prompt reads above, and a
      // `reset` in that gap archived it and revoked its tokens. `reset` holds this same lock for its
      // writes, so this read is authoritative — without it the run would write rows nobody sees and mint
      // a fresh token bound to a conversation that is over, after its revocation.
      const live = await this.deps.repos.chat.findByIdForUser(conversation.id, user.id);
      if (!live || live.archived_at !== null) throw new HttpError(409, 'Esta conversa foi encerrada; envie de novo para começar a nova conversa', 'CHAT_ARCHIVED');

      // The host this run uses is the host this conversation has, and from here on it says so: a
      // conversation whose machine was auto-picked (one candidate, nothing stored) is otherwise
      // indistinguishable from one whose stored host was unenrolled out from under a live session, and
      // those two need opposite screens — see `pinHostMachine`. Only ever fills a null, so it can
      // never move a host the user chose; after the lock, so it only ever records a run that happens.
      // The host belongs to the account-wide conversation, which is not necessarily this one: a project
      // chat pins the row `resolveHost` read, never its own (which has no host to speak of).
      const hostConversation = conversation.project_id === null ? conversation : await this.deps.repos.chat.getOrCreateForUser(user.id);
      await this.deps.repos.chat.pinHostMachine(hostConversation.id, host.machine.id);

      // Only ever set by a decision's re-injection, and only reached once the lock above is actually
      // held — marking the row happens here, never before the lock check, so a busy run can never
      // mark a decision injected that it never actually sent (fix round 2).
      if (opts?.beforeRun) await opts.beforeRun();

      const question = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'user', text });
      chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: question });

      const answer = await this.deps.repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text: '' });
      chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: answer });

      // Not awaited: this call resolves now, and the lock passes to `finishRun`, whose own `finally`
      // releases it whether or not anybody ever awaits `done`.
      const done = this.finishRun(user, conversation, text, question, answer, runner, host.configDir, appendSystemPrompt);
      handedOff = true;
      return { conversation_id: conversation.id, user_message_id: question.id, assistant_message_id: answer.id, done };
    } finally {
      // Anything thrown before the hand-off (an archived conversation, `beforeRun`, a failed insert)
      // never reaches `finishRun`, so the lock is released here instead, exactly as it always was.
      if (!handedOff) this.releaseLock(user, conversation.id);
    }
  }

  /** The second half of a run: the stream, the one retry, the stored answer. Holds the lock `startIn`
   * took and releases it in every path. Announces its end with `run_finished` exactly once. */
  private async finishRun(
    user: User,
    conversation: ChatConversation,
    text: string,
    question: ChatMessage,
    answer: ChatMessage,
    runner: RunnerClient,
    configDir: string | null,
    appendSystemPrompt: string | null,
  ): Promise<ChatMessage> {
    try {
      let collected = '';
      let usage: unknown = null;
      /** Whether a `done` frame was seen for the run currently being consumed. A stream that ends
       * (the container closes the body, e.g. an OOM kill) without one must not be mistaken for a
       * clean finish: the text collected so far looks complete but isn't, and cli_session_id would
       * silently stay unset. */
      let sawDone = false;
      /** Set by an error frame whose reason says the CLI does not have the session we asked it to
       * resume. It is the container that classifies this (it is the only side that sees the CLI's
       * stderr, which never travels): the app reads the frame's `reason`, never an error's text. */
      let missingSession = false;
      /** Set once something went wrong. Distinct from a runner failure: the run never started
       * because the server itself could not mint a credential (nothing the account can fix by
       * being switched), vs. a run that started and died mid-stream (often account/quota, which
       * account fallback can act on). */
      let errorCode: ChatErrorCode = null;

      const consume = async (run: RunnerInput) => {
        for await (const line of runner.run(run)) {
          const frame = parseFrame(line);
          if (!frame) continue;
          if (frame.type === 'text') {
            collected += frame.delta;
            chatBus.publish({ type: 'delta', user_id: user.id, conversation_id: conversation.id, message_id: answer.id, delta: frame.delta });
          } else if (frame.type === 'action') {
            chatBus.publish({ type: 'action', user_id: user.id, conversation_id: conversation.id, message_id: answer.id, tool: frame.tool, tool_use_id: frame.tool_use_id, args: frame.args });
          } else if (frame.type === 'action_result') {
            chatBus.publish({ type: 'action_result', user_id: user.id, conversation_id: conversation.id, message_id: answer.id, tool_use_id: frame.tool_use_id, ok: frame.ok });
          } else if (frame.type === 'done') {
            sawDone = true;
            usage = frame.usage ?? null;
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          } else if (frame.type === 'error') {
            // The reason is the container's closed-set classification, so a failure is diagnosable
            // from the stored row alone: CLI_REJECTED means our own flags were refused, which no
            // amount of retrying fixes. Without this, every failure looked the same and finding the
            // cause meant probing the container by hand.
            errorCode = codeForReason(frame.reason);
            if (frame.reason === 'missing_session') missingSession = true;
            // A failed run still leaves its session, and the whole transcript, on disk: this server
            // generated the uuid and passed it as --session-id, so there is nothing unknown about
            // it. Dropping it here would make the next message mint a fresh uuid and silently lose
            // the thread — the user's follow-up would arrive at a concierge with no context. The
            // genuinely gone session is the `missing_session` case, cleared below.
            if (frame.session_id && frame.session_id !== conversation.cli_session_id) await this.deps.repos.chat.setCliSession(conversation.id, frame.session_id);
          }
        }
      };

      // Minting can fail (see mintConciergeToken's note: the previous token is already revoked by
      // the time create() might throw). Either way the failure must land on the assistant message,
      // not escape send() and leave an empty bubble with no explanation.
      let token: string | undefined;
      try {
        // Wide scopes are safe here only because mintConciergeToken always pairs them with
        // `gated: true` — every write this token can attempt still stops at the chat's gate.
        token = await mintConciergeToken(this.deps.repos, user.id, conversation.id, ['read', 'tasks', 'terminals'], { accountWide: conversation.project_id === null });
      } catch {
        errorCode = 'TOKEN_FAILED';
      }

      if (token !== undefined) {
        const sessionId = conversation.cli_session_id ?? randomUUID();
        const input: RunnerInput = {
          session_id: sessionId,
          resume: conversation.cli_session_id !== null,
          text,
          config_dir: configDir,
          model: conversation.model,
          token,
          append_system_prompt: appendSystemPrompt,
        };

        try {
          await consume(input);
          // Only when nothing has already said why: an error frame's own reason (cli_missing above
          // all, the likeliest first failure of a chat on someone's own machine) is the whole point of
          // carrying a label from the machine to the screen, and overwriting it here with the generic
          // "a resposta não terminou" threw it away one step before it was read.
          if (!sawDone && errorCode === null) errorCode = 'RUNNER_FAILED';
        } catch (e) {
          if (isSetupFailure(e)) {
            // Nothing ran and nothing will: drop the empty assistant row instead of leaving a
            // bubble that would say "pensando…" for ever, and let the status reach the browser.
            await this.deps.repos.chat.deleteMessage(answer.id);
            // Re-publishing the question makes every open tab re-read the conversation, which is
            // how they learn the assistant row is gone (the bus has no "removed" event).
            chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: question });
            this.publishSetupFailure(user, conversation.id);
            throw e;
          }
          // The stream itself broke (the container closed the socket, the deadline aborted it):
          // there is no frame to read a reason from, so this can only be a plain failure.
          errorCode = 'RUNNER_FAILED';
        }

        // A resume the account cannot honour is not a failure: start a fresh session once. The
        // signal is the error frame's reason, the only thing the container can tell us about the
        // CLI's stderr without forwarding it.
        if (input.resume && missingSession) {
          const fresh = { ...input, resume: false, session_id: randomUUID() };
          // The failed attempt may have streamed partial text before dying; that text (and
          // whatever the browser already rendered for it) belongs to a session the CLI has
          // discarded, so both sides must start the answer over.
          collected = '';
          sawDone = false;
          missingSession = false;
          errorCode = null;
          chatBus.publish({ type: 'reset', user_id: user.id, conversation_id: conversation.id, message_id: answer.id });
          await this.deps.repos.chat.setCliSession(conversation.id, null);
          try {
            await consume(fresh);
            if (!sawDone && errorCode === null) errorCode = 'RUNNER_FAILED';
          } catch (e) {
            if (isSetupFailure(e)) {
              await this.deps.repos.chat.deleteMessage(answer.id);
              chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: question });
              this.publishSetupFailure(user, conversation.id);
              throw e;
            }
            errorCode = 'RUNNER_FAILED';
          }
        }
      }

      const final = await this.deps.repos.chat.updateMessage(answer.id, { text: collected, usage, error_code: errorCode });
      chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: final });
      chatBus.publish({ type: 'run_finished', user_id: user.id, conversation_id: conversation.id, message_id: final.id, ok: errorCode === null, error_code: errorCode });
      return final;
    } finally {
      this.releaseLock(user, conversation.id);
    }
  }

  /** A run that could not even be attempted (`isSetupFailure`): its assistant row is already gone. */
  private publishSetupFailure(user: User, conversationId: string): void {
    chatBus.publish({ type: 'run_finished', user_id: user.id, conversation_id: conversationId, message_id: null, ok: false, error_code: 'SETUP_FAILED' });
  }

  /** Frees a conversation's run lock and hands the conversation to the decision drain. */
  private releaseLock(user: User, conversationId: string): void {
    this.running.delete(conversationId);
    // The lock is free: if a decision was recorded while it was held (fix round 2) and could not
    // be injected immediately, this is where it finally gets its turn. Scheduled, never awaited:
    // the drain starts a CLI run of its own, whose completion schedules another — awaiting it would
    // hold this request open across every run the backlog needs (a user who approves two actions
    // during one run would keep their original `POST /api/chat/messages` open across three runs, and
    // nginx would cut the client while the runs carried on). The answer this request came for is
    // already stored and published, so the client loses nothing by being answered now: the injected
    // runs reach it over the chat's own stream, exactly as they do for a decision taken while idle.
    // `drainNextDecision` logs its own failure (metadata only) and resolves; the `catch` is the last
    // guard that nothing from it can ever become this run's outcome or an unhandled rejection.
    void this.drainNextDecision(user, conversationId).catch(() => {});
  }
}
