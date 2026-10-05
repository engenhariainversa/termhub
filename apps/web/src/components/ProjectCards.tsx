import { Link } from 'react-router-dom';
import type { MachineStatus } from '../lib/data';
import type { DashboardItem } from '../lib/types';
import { formatDate } from '../lib/format';
import { i18n, useTranslation } from '../i18n';

function relative(iso: string | null): string {
  if (!iso) return i18n.t('nunca');
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return i18n.t('agora');
  if (m < 60) return i18n.t('há {{n}} min', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return i18n.t('há {{n}} h', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return i18n.t('há {{count}} dias', { count: d });
  return formatDate(iso);
}

function ProjectCard({ item: { project: p, machines, doing, open_tasks }, statuses }: { item: DashboardItem; statuses: Record<string, MachineStatus> }) {
  const { t } = useTranslation();
  return (
    <li className="flex flex-col rounded-lg border border-line bg-bg-2 p-4 hover:border-accent/60">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-fg-dim">{p.key}</span>
        <Link to={`/projects/${p.id}`} className="truncate font-medium hover:underline">
          {p.name}
        </Link>
      </div>
      <ul className="mt-1 flex flex-wrap gap-2 text-[11px] text-fg-dim">
        {machines.length === 0 && <li>{t('sem máquina')}</li>}
        {machines.map((m) => {
          const st = statuses[m.id] ?? 'checking';
          return (
            <li key={m.id} className="flex items-center gap-1" title={p.machines.find((l) => l.machine_id === m.id)?.cwd}>
              <span className={`h-1.5 w-1.5 rounded-full ${st === 'online' ? 'bg-ok' : st === 'offline' ? 'bg-danger' : 'bg-warn'}`} />
              {m.name}
            </li>
          );
        })}
      </ul>
      {p.description && <p className="mt-2 line-clamp-2 text-xs text-fg-muted">{p.description}</p>}

      <div className="mt-3 flex-1">
        <div className="mb-1 flex items-center text-[11px] uppercase tracking-wide text-fg-dim">
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          {t('Fazendo')}
          <Link to={`/projects/${p.id}/tasks`} className="ml-auto normal-case tracking-normal hover:text-fg">
            {t('{{count}} abertas →', { count: open_tasks })}
          </Link>
        </div>
        {doing.length === 0 ? (
          <p className="text-xs text-fg-dim">{t('nada em andamento')}</p>
        ) : (
          <ul className="space-y-1">
            {doing.slice(0, 4).map((task) => (
              <li key={task.id} className="truncate rounded bg-bg-3 px-2 py-1 text-xs" title={task.title}>
                {task.title}
              </li>
            ))}
            {doing.length > 4 && <li className="px-2 text-xs text-fg-dim">+{doing.length - 4}</li>}
          </ul>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-[11px] text-fg-dim">
        <span>{t('terminal: {{when}}', { when: relative(p.last_terminal_at) })}</span>
        <Link to={`/projects/${p.id}`} className="text-accent hover:underline">
          {t('abrir terminais')}
        </Link>
      </div>
    </li>
  );
}

/** Home: the active projects, one card each, newest terminal activity first (the API's order). */
export function ProjectCards({ items, statuses }: { items: DashboardItem[]; statuses: Record<string, MachineStatus> }) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map((i) => (
        <ProjectCard key={i.project.id} item={i} statuses={statuses} />
      ))}
    </ul>
  );
}
