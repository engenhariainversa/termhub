/**
 * `watch`, `list_watches` and `cancel_watch` (TER-1099): the concierge asks the server to wake it when
 * something happens — a tab stops, a card moves, a PR is merged or its CI goes red, a deploy or a release
 * ends, a machine comes back, an agent version is out — instead of a subagent that waits (and dies at every
 * restart). Only in the chat: the watch belongs to the conversation's scope (the person and the project),
 * and the wake goes to that scope's active conversation.
 */
import { agents } from '../agent/registry.js';
import type { ChatWatch } from '../db/repositories/chat-watches.js';
import { initialBaseline, type WatchProbe } from '../chat/watches/evaluate.js';
import { DEFAULT_EVENTS, EVENTS_BY_KIND, SEMVER, WATCH_LIMITS, type CardStatus, type WatchKind, type WatchParams } from '../chat/watches/kinds.js';
import { createWatchProbe } from '../chat/watches/probe.js';
import { cancelWatchRow, publishWatches, watchView, type WatchView } from '../chat/watches/view.js';
import { msg, type LocalizedText } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

const NOT_IN_CHAT = () => new ControlError('NOT_IN_CHAT', 'Esta ferramenta só funciona no chat do termhub: a assinatura acorda a própria conversa.');
const TASK_REF = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export interface WatchArgs {
  kind: WatchKind;
  tab_id?: string;
  task_id?: string;
  pr_url?: string;
  machine_id?: string;
  version?: string;
  events?: string[];
  to?: CardStatus;
  workflow?: string;
  note: string;
  hours?: number;
  recurring?: boolean;
}

export interface WatchResult {
  watch: WatchView;
  /** The target's state right now, so the person can be told at once when it is already there. */
  current: Record<string, unknown>;
  note: string;
}

/** The conversation's scope; the tools refuse outside the chat. */
async function chatScope(ctx: ControlContext): Promise<{ conversationId: string; projectId: string | null }> {
  const conversationId = ctx.token?.chat_conversation_id;
  if (!conversationId) throw NOT_IN_CHAT();
  const conversation = await ctx.repos.chat.findByIdForUser(conversationId, ctx.scope.user.id);
  if (!conversation) throw NOT_IN_CHAT();
  return { conversationId, projectId: conversation.project_id };
}

const bad = (message: LocalizedText) => new ControlError('INVALID_WATCH', message);

/** The watched target, owner-scoped: its id, its name for lists and wakes, and the params the kind keeps. */
async function resolveTarget(ctx: ControlContext, a: WatchArgs): Promise<{ targetId: string | null; label: string; params: Omit<WatchParams, 'events'> }> {
  switch (a.kind) {
    case 'tab': {
      if (!a.tab_id) throw bad(msg('Informe tab_id para acompanhar uma aba.'));
      const { tab } = await ctx.scoped.tab(a.tab_id);
      return { targetId: tab.id, label: tab.name, params: {} };
    }
    case 'card': {
      if (!a.task_id) throw bad(msg('Informe task_id (o id ou a referência, como TER-12) para acompanhar um card.'));
      const { task } = TASK_REF.test(a.task_id) ? await ctx.scoped.taskByRef(a.task_id) : await ctx.scoped.task(a.task_id);
      return { targetId: task.id, label: `${task.ref} ${task.title}`.slice(0, 200), params: a.to ? { to: a.to } : {} };
    }
    case 'pr': {
      const workflow = a.workflow ? { workflow: a.workflow } : {};
      if (a.pr_url) {
        if (!PR_URL.test(a.pr_url)) throw bad(msg('pr_url deve ser a URL de um pull request do GitHub (https://github.com/dono/repo/pull/123).'));
        const rows = await ctx.repos.taskPullRequests.listByUrlForOwner(a.pr_url, ctx.scope.user.id);
        if (rows.length === 0)
          throw new ControlError('PR_NOT_TRACKED', 'O termhub não acompanha este PR: ele precisa citar um card de um projeto seu com a integração do GitHub (o painel de CI). Acompanhe pelo card (task_id).');
        return { targetId: null, label: `PR #${rows[0].number} ${rows[0].title}`.slice(0, 200), params: { pr_url: a.pr_url, ...workflow } };
      }
      if (!a.task_id) throw bad(msg('Informe pr_url ou task_id (os PRs do card) para acompanhar um pull request.'));
      const { task } = TASK_REF.test(a.task_id) ? await ctx.scoped.taskByRef(a.task_id) : await ctx.scoped.task(a.task_id);
      return { targetId: task.id, label: `PRs de ${task.ref} ${task.title}`.slice(0, 200), params: workflow };
    }
    case 'machine': {
      if (!a.machine_id) throw bad(msg('Informe machine_id para acompanhar uma máquina.'));
      const m = await ctx.scoped.machine(a.machine_id);
      return { targetId: m.id, label: m.name, params: {} };
    }
    case 'agent_release': {
      if (!a.version || !SEMVER.test(a.version)) throw bad(msg('Informe version (x.y.z): a menor versão do @termhub/agent que conta.'));
      return { targetId: null, label: `@termhub/agent ≥ ${a.version}`, params: { version: a.version } };
    }
  }
}

/** A short reading of the target now, for the answer. */
async function currentOf(probe: WatchProbe, w: Pick<ChatWatch, 'user_id' | 'kind' | 'target_id' | 'params'>): Promise<Record<string, unknown>> {
  switch (w.kind) {
    case 'tab':
      return { state: (await probe.tab(w.target_id!))?.state ?? null };
    case 'card': {
      const t = await probe.task(w.target_id!);
      return { status: t?.status ?? null };
    }
    case 'pr':
      return { pull_requests: (await probe.pullRequests(w)).map((p) => ({ number: p.number, url: p.url, state: p.state, ci_state: p.ci_state, deploy_state: p.deploy_state })) };
    case 'machine':
      return { online: (await probe.machine(w.target_id!))?.online ?? false };
    case 'agent_release':
      return { latest: await probe.latestAgentVersion() };
  }
}

export async function watch(ctx: ControlContext, a: WatchArgs, probe: WatchProbe = createWatchProbe({ repos: ctx.repos, agents })): Promise<WatchResult> {
  const { conversationId, projectId } = await chatScope(ctx);
  const userId = ctx.scope.user.id;
  const events = a.events?.length ? [...new Set(a.events)] : [...DEFAULT_EVENTS[a.kind]];
  const unknown = events.filter((e) => !EVENTS_BY_KIND[a.kind].includes(e));
  if (unknown.length) throw bad(msg('Eventos que {{kind}} não tem: {{unknown}}. Use: {{events}}.', { kind: a.kind, unknown: unknown.join(', '), events: EVENTS_BY_KIND[a.kind].join(', ') }));
  const hours = a.hours ?? WATCH_LIMITS.defaultHours;
  if (!(hours > 0 && hours <= WATCH_LIMITS.maxHours)) throw bad(msg('hours vai de um pouco mais de 0 até {{max}} (7 dias).', { max: WATCH_LIMITS.maxHours }));
  if ((await ctx.repos.chatWatches.countOpen(userId, projectId)) >= WATCH_LIMITS.openPerScope)
    throw new ControlError('WATCH_LIMIT', msg('Esta conversa já tem {{max}} assinaturas abertas: cancele alguma com cancel_watch (list_watches lista todas) antes de criar outra.', { max: WATCH_LIMITS.openPerScope }));
  const target = await resolveTarget(ctx, a);
  const params: WatchParams = { events, ...target.params };
  const now = new Date();
  const base = { user_id: userId, kind: a.kind, target_id: target.targetId, params };
  const row = await ctx.repos.chatWatches.create(
    {
      ...base,
      project_id: projectId,
      conversation_id: conversationId,
      baseline: await initialBaseline(probe, base, now),
      label: target.label,
      note: a.note.trim().slice(0, WATCH_LIMITS.noteMax),
      recurring: a.recurring === true,
      expires_at: new Date(now.getTime() + hours * 3600_000),
    },
    now,
  );
  await publishWatches(ctx.repos, userId, projectId);
  return {
    watch: watchView(row),
    current: await currentOf(probe, row).catch(() => ({})),
    note:
      'Assinatura criada: o servidor acorda esta conversa quando acontecer (também depois de reinícios), com a sua nota. Conta só o que mudar a partir de agora: se `current` já mostra o que a pessoa quer saber, diga já. Não lance subagente para esperar.' +
      (a.kind === 'agent_release' ? ' Se a versão já estiver no npm, o aviso chega na próxima verificação.' : ''),
  };
}

export async function listWatches(ctx: ControlContext): Promise<{ watches: WatchView[] }> {
  const { projectId } = await chatScope(ctx);
  return { watches: (await ctx.repos.chatWatches.listOpen(ctx.scope.user.id, projectId)).map(watchView) };
}

export async function cancelWatch(ctx: ControlContext, a: { watch_id: string }): Promise<{ watch: WatchView }> {
  await chatScope(ctx);
  const watch = await cancelWatchRow(ctx.repos, ctx.scope.user.id, a.watch_id);
  if (!watch) throw new ControlError('WATCH_NOT_FOUND', 'Assinatura não encontrada ou já encerrada.');
  return { watch };
}
