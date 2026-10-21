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
import { DEFAULT_EVENTS, EVENTS_BY_KIND, REMINDER_LIMITS, SEMVER, WATCH_LIMITS, type CardStatus, type TargetKind, type WatchParams } from '../chat/watches/kinds.js';
import { createWatchProbe } from '../chat/watches/probe.js';
import { cancelWatchRow, publishWatches, watchView, type WatchView } from '../chat/watches/view.js';
import { msg, type LocalizedText } from '../i18n/index.js';
import { formatLocal, localDateTime, nextLocalTime, zoneOrUtc } from '../lib/local-time.js';
import { ControlError, type ControlContext } from './context.js';

const NOT_IN_CHAT = () => new ControlError('NOT_IN_CHAT', 'Esta ferramenta só funciona no chat do termhub: a assinatura acorda a própria conversa.');
const TASK_REF = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,6}$/;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

export interface WatchArgs {
  kind: TargetKind;
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
    case 'reminder':
      return {};
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

export interface ScheduleWakeupArgs {
  /** In this many minutes. */
  in_minutes?: number;
  /** At this moment: ISO 8601 with an offset, or "YYYY-MM-DDTHH:MM" on the person's clock. */
  at?: string;
  /** At the next time the person's clock reads "HH:MM". */
  at_time?: string;
  note: string;
  every_minutes?: number;
  times?: number;
  /** A repeating reminder stops here: ISO 8601 with an offset, or "YYYY-MM-DDTHH:MM" on the person's clock. */
  until?: string;
  /** A repeating reminder stops at the next time the person's clock reads "HH:MM" after the first one. */
  until_time?: string;
}

export interface ScheduleWakeupResult {
  watch: WatchView;
  /** When it is due first, as an instant and on the person's clock. */
  due_at: string;
  due_local: string;
  time_zone: string;
  /** A repeating reminder's last possible time, on the person's clock. */
  until_local: string | null;
  note: string;
}

const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** An `at`/`until` value: with an offset it is that instant; without, it is read on the person's clock. */
function instantOf(text: string, zone: string): Date | null {
  if (OFFSET_ISO.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return localDateTime(text, zone);
}

/**
 * `schedule_wakeup` (TER-1100): "me acorde em 5 min", "às 18:00 confira o build". A reminder is a watch of
 * kind `reminder` — same table, same engine, same wake, same list and "Cancelar" in the chat — whose event
 * is the clock passing its time. Times without an offset are on the person's clock (their stored time
 * zone, TER-1088; UTC when they have none), and the answer tells the time back on it so the concierge can
 * confirm it. Limits: at most `REMINDER_LIMITS.openPerScope` open (and the watches' own cap), every 5 min
 * at most, a cap on repetitions, and nothing beyond 7 days.
 */
export async function scheduleWakeup(ctx: ControlContext, a: ScheduleWakeupArgs, now = new Date()): Promise<ScheduleWakeupResult> {
  const { conversationId, projectId } = await chatScope(ctx);
  const userId = ctx.scope.user.id;
  const zone = zoneOrUtc(await ctx.repos.users.timeZone(userId));
  const given = [a.in_minutes, a.at, a.at_time].filter((v) => v !== undefined).length;
  if (given !== 1) throw bad(msg('Informe exatamente um entre in_minutes, at e at_time.'));
  const due =
    a.in_minutes !== undefined ? new Date(now.getTime() + a.in_minutes * 60_000)
    : a.at !== undefined ? instantOf(a.at, zone)
    : nextLocalTime(a.at_time!, zone, now);
  if (!due) throw bad(msg('at deve ser ISO 8601 com fuso (2026-10-21T18:00:00-03:00) ou "AAAA-MM-DDTHH:MM" no relógio da pessoa.'));
  const maxMs = WATCH_LIMITS.maxHours * 3600_000;
  if (due.getTime() <= now.getTime()) throw bad(msg('O horário do lembrete já passou ({{local}}, {{zone}}).', { local: formatLocal(due, zone), zone }));
  if (due.getTime() > now.getTime() + maxMs) throw bad(msg('Um lembrete vale por no máximo 7 dias a partir de agora.'));

  const repeating = a.every_minutes !== undefined;
  if (!repeating && (a.times !== undefined || a.until !== undefined || a.until_time !== undefined)) throw bad(msg('times, until e until_time só valem com every_minutes.'));
  if (repeating && a.every_minutes! < REMINDER_LIMITS.minEveryMinutes) throw bad(msg('every_minutes deve ser no mínimo {{min}}.', { min: REMINDER_LIMITS.minEveryMinutes }));
  if (a.times !== undefined && !(Number.isInteger(a.times) && a.times >= 1 && a.times <= REMINDER_LIMITS.maxTimes)) throw bad(msg('times vai de 1 a {{max}}.', { max: REMINDER_LIMITS.maxTimes }));
  if (a.until !== undefined && a.until_time !== undefined) throw bad(msg('Informe until ou until_time, não os dois.'));
  let until: Date | null = null;
  if (repeating) {
    const asked = a.until !== undefined ? instantOf(a.until, zone) : a.until_time !== undefined ? nextLocalTime(a.until_time, zone, due) : null;
    if ((a.until !== undefined || a.until_time !== undefined) && !asked) throw bad(msg('until deve ser ISO 8601 com fuso ou "AAAA-MM-DDTHH:MM" no relógio da pessoa.'));
    if (asked && asked.getTime() < due.getTime()) throw bad(msg('until precisa ser depois da primeira vez do lembrete.'));
    // Neither a count nor an end: it repeats for a day. Never past 7 days from now.
    const fallback = a.times === undefined ? due.getTime() + REMINDER_LIMITS.defaultRepeatHours * 3600_000 : Infinity;
    const byTimes = a.times !== undefined ? due.getTime() + (a.times - 1) * a.every_minutes! * 60_000 : Infinity;
    until = new Date(Math.min(asked?.getTime() ?? fallback, byTimes, now.getTime() + maxMs));
  }

  const open = await ctx.repos.chatWatches.listOpen(userId, projectId);
  if (open.length >= WATCH_LIMITS.openPerScope)
    throw new ControlError('WATCH_LIMIT', msg('Esta conversa já tem {{max}} assinaturas abertas: cancele alguma com cancel_watch (list_watches lista todas) antes de criar outra.', { max: WATCH_LIMITS.openPerScope }));
  if (open.filter((w) => w.kind === 'reminder').length >= REMINDER_LIMITS.openPerScope)
    throw new ControlError('REMINDER_LIMIT', msg('Esta conversa já tem {{max}} lembretes abertos: cancele algum com cancel_watch (list_watches lista todos) antes de criar outro.', { max: REMINDER_LIMITS.openPerScope }));

  const note = a.note.trim().slice(0, WATCH_LIMITS.noteMax);
  const params: WatchParams = {
    events: ['due'],
    at: due.toISOString(),
    zone,
    ...(repeating ? { every_minutes: a.every_minutes, until: until!.toISOString(), ...(a.times !== undefined ? { times: a.times } : {}) } : {}),
  };
  // A safety net only: the engine fires a reminder whose time passed before it ever expires it.
  const last = until ?? due;
  const row = await ctx.repos.chatWatches.create(
    {
      user_id: userId,
      kind: 'reminder',
      target_id: null,
      params,
      project_id: projectId,
      conversation_id: conversationId,
      baseline: { next: due.toISOString() },
      label: note.split('\n')[0]!.slice(0, 120),
      note,
      recurring: repeating,
      expires_at: new Date(last.getTime() + 3600_000),
    },
    now,
  );
  await publishWatches(ctx.repos, userId, projectId);
  const dueLocal = formatLocal(due, zone);
  return {
    watch: watchView(row),
    due_at: due.toISOString(),
    due_local: dueLocal,
    time_zone: zone,
    until_local: until ? formatLocal(until, zone) : null,
    note:
      `Lembrete criado: o servidor acorda esta conversa em ${dueLocal} (${zone}), com a sua nota, mesmo depois de reinícios; se o servidor estiver fora na hora, acorda assim que voltar e diz o atraso. ` +
      'Confirme à pessoa o horário no fuso dela (due_local). list_watches lista os lembretes, cancel_watch cancela. Não lance subagente para esperar.',
  };
}
