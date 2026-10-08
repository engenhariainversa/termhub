import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useMonitor } from '../lib/monitor';
import { useData } from '../lib/data';
import { ApiError } from '../lib/api';
import { emptyMonitorHint, tabNeedsYou } from '../lib/needs-you';
import { ANSWERABLE, NEEDS_YOU, TAB_STATE_LABEL, type MonitorItem, type TabState } from '../lib/types';
import { i18n, useTranslation } from '../i18n';

function since(iso: string | null, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return i18n.t('há {{n}} s', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return i18n.t('há {{n}} min', { n: m });
  return i18n.t('há {{n}} h', { n: Math.round(m / 60) });
}

function stateStyle(state: TabState | null): string {
  switch (state) {
    case 'waiting_permission':
      return 'bg-warn/15 text-warn';
    case 'waiting_input':
      return 'bg-accent/15 text-accent';
    case 'idle':
    case 'waiting_background':
      return 'bg-bg-4 text-fg-muted';
    case 'error':
    case 'auth_required':
      return 'bg-danger/15 text-danger';
    case 'trust_prompt':
      return 'bg-attention/15 text-attention';
    case 'blocked':
      return 'bg-bg-4 text-fg-muted';
    // done, asking nothing (TER-972): falls through to the green of a healthy tab
    case 'finished':
    default:
      return 'bg-ok/15 text-ok';
  }
}

function Item({ item, now }: { item: MonitorItem; now: number }) {
  const { t } = useTranslation();
  const { reply } = useMonitor();
  const { can } = useAuth();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tab, project } = item;
  // The highlight follows "needs you" (drops once seen); the quick-reply form follows the raw
  // state — the tool is still actually waiting for an answer either way, seen or not.
  const waiting = tabNeedsYou(tab);
  // Replying types into the terminal: it takes terminals:write (TER-576), like typing in the tab itself.
  // A login or the trust dialog is not answered with text (TER-1046): the person opens the tab.
  const canReply = !!tab.state && ANSWERABLE.includes(tab.state) && can('terminals', 'write');

  const send = async (e: FormEvent, value = text) => {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await reply(tab.id, value);
      setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Não foi possível enviar'));
    } finally {
      setSending(false);
    }
  };

  return (
    <li className={`rounded-lg border bg-bg-2 p-2.5 sm:p-3 ${waiting ? 'border-accent/50' : 'border-line'}`}>
      {/* narrow: the state and the time on the first line, project › tab on a line of its own;
          from sm up, everything on one line as before */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className={`shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold ${stateStyle(tab.state)}`}>{tab.state ? t(TAB_STATE_LABEL[tab.state]) : '—'}</span>
        <span data-testid="needs-you-where" className="order-last flex w-full min-w-0 items-center gap-2 sm:order-none sm:w-auto sm:flex-1">
          <Link to={`/projects/${project.id}`} className="max-w-[60%] shrink-0 truncate font-medium hover:underline">
            {project.name}
          </Link>
          <span className="min-w-0 truncate text-fg-dim">
            › {tab.name}
            {tab.state_tool ? ` · ${tab.state_tool}` : ''}
          </span>
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-fg-dim">{since(tab.state_at, now)}</span>
      </div>
      {tab.state_text && <p className="mt-2 whitespace-pre-wrap break-words rounded bg-bg-3 px-2 py-1.5 text-xs text-fg">{tab.state_text}</p>}
      {canReply && (
        <form className="mt-2 flex items-center gap-2" onSubmit={send}>
          <input
            className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
            placeholder={tab.state === 'waiting_permission' ? t('Resposta (Enter aceita)…') : t('Responder…')}
            aria-label={tab.state === 'waiting_permission' ? t('Resposta (ou só Enter para aceitar)') : t('Responder no terminal')}
            value={text}
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
          />
          {tab.state === 'waiting_permission' && (
            <button type="button" className="rounded bg-bg-3 px-2 py-1 text-xs hover:bg-bg-4 disabled:opacity-50" disabled={sending} onClick={(e) => void send(e, 'y')}>
              {/* i18n-ignore: the key sent to the terminal */}
              y
            </button>
          )}
          <button type="submit" className="rounded bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50" disabled={sending}>
            {sending ? '…' : t('Enviar ⏎')}
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

export interface MachineGroup {
  machine: MonitorItem['machine'];
  /** needs you: waiting and not seen since */
  waiting: MonitorItem[];
  /** still waiting_*, but the person already looked at it since — nothing to do here right now */
  seen: MonitorItem[];
  /** idle or error */
  finished: MonitorItem[];
  working: number;
}

/**
 * One accordion per machine, split into three buckets, in this render order: waiting (needs you,
 * highlighted) → seen (still waiting_*, but already looked at) → finished (idle/finished/error). The ones
 * with someone waiting open (and sort first); the rest collapsed. Pure — unit-tested directly.
 */
export function groupMachineItems(items: MonitorItem[]): MachineGroup[] {
  const groups = new Map<string, MachineGroup>();
  for (const item of items) {
    let g = groups.get(item.machine.id);
    if (!g) {
      g = { machine: item.machine, waiting: [], seen: [], finished: [], working: 0 };
      groups.set(item.machine.id, g);
    }
    const st = item.tab.state;
    if (tabNeedsYou(item.tab)) g.waiting.push(item);
    else if (st && NEEDS_YOU.includes(st)) g.seen.push(item); // waiting_*, already seen
    else if (st === 'idle' || st === 'finished' || st === 'blocked' || st === 'error') g.finished.push(item);
    else g.working += 1;
  }
  const oldestWaiting = (g: MachineGroup) => (g.waiting.length ? Math.min(...g.waiting.map((i) => new Date(i.tab.state_at ?? 0).getTime())) : Number.POSITIVE_INFINITY);
  return [...groups.values()].sort((a, b) => oldestWaiting(a) - oldestWaiting(b) || a.machine.name.localeCompare(b.machine.name));
}

const OPEN_KEY = 'termhub:needs-you-open';

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

function MachineSection({ group, now, open, onToggle }: { group: MachineGroup; now: number; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { statuses } = useData();
  const { machine, waiting, seen, finished, working } = group;
  const st = statuses[machine.id] ?? 'checking';
  const summary = [
    waiting.length ? t('{{n}} esperando', { n: waiting.length }) : null,
    seen.length ? t('{{count}} vistos', { count: seen.length }) : null,
    finished.length ? t('{{n}} terminou', { n: finished.length }) : null,
    working ? t('{{n}} trabalhando', { n: working }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const hasContent = waiting.length > 0 || seen.length > 0 || finished.length > 0;
  return (
    <li className={`rounded-lg border bg-bg-2 ${waiting.length ? 'border-accent/50' : 'border-line'}`}>
      <button type="button" className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-bg-3" onClick={onToggle} aria-expanded={open}>
        <span className={`text-[10px] text-fg-dim transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
          ▶
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${st === 'online' ? 'bg-ok' : st === 'offline' ? 'bg-danger' : 'bg-warn'}`} title={st} />
        <span className="min-w-0 flex-1 truncate font-medium sm:flex-none" title={machine.name}>
          {machine.name}
        </span>
        {waiting.length > 0 && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[11px] font-semibold text-accent">{waiting.length}</span>}
        {/* narrow: under the name, aligned with it; from sm up, on the right as before */}
        <span data-testid="needs-you-summary" className="w-full truncate pl-8 text-xs text-fg-dim sm:ml-auto sm:w-auto sm:pl-0">
          {summary || t('sem atividade')}
        </span>
      </button>
      {open && hasContent && (
        <ul className="space-y-2 border-t border-line p-2">
          {waiting.map((i) => (
            <Item key={i.tab.id} item={i} now={now} />
          ))}
          {seen.map((i) => (
            <Item key={i.tab.id} item={i} now={now} />
          ))}
          {finished.slice(0, 6).map((i) => (
            <Item key={i.tab.id} item={i} now={now} />
          ))}
        </ul>
      )}
      {open && !hasContent && <p className="border-t border-line px-3 py-2 text-xs text-fg-dim">{t('Nenhuma tab esperando você aqui.')}</p>}
    </li>
  );
}

/** Home: one accordion per machine; machines with someone waiting come first and start open. */
export function NeedsYouList({ now }: { now: number }) {
  const { t } = useTranslation();
  const { items, needsYou, connected } = useMonitor();
  const { machines } = useData();
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const groups = useMemo(() => groupMachineItems(items), [items]);
  const hint = items.length === 0 ? emptyMonitorHint(machines) : null;
  if (items.length === 0) {
    if (!hint) return null;
    return (
      <section className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('Precisando de você')}</h2>
        </div>
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">{hint}</p>
      </section>
    );
  }
  const isOpen = (g: MachineGroup) => open[g.machine.id] ?? g.waiting.length > 0;
  const toggle = (g: MachineGroup) => {
    const next = { ...open, [g.machine.id]: !isOpen(g) };
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice just does not persist */
    }
  };
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">{t('Precisando de você')}</h2>
        <span className="text-xs text-fg-dim">{needsYou.length === 0 ? t('ninguém esperando') : t('{{n}} esperando', { n: needsYou.length })}</span>
        {!connected && <span className="ml-auto text-[11px] text-warn">{t('reconectando…')}</span>}
      </div>
      <ul className="space-y-2">
        {groups.map((g) => (
          <MachineSection key={g.machine.id} group={g} now={now} open={isOpen(g)} onToggle={() => toggle(g)} />
        ))}
      </ul>
    </section>
  );
}
