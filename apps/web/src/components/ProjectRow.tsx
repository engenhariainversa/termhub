import { useId, type HTMLAttributes } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { pinTab, previewTab, updateEditorTabs, useEditorTabs } from '../lib/editor-tabs';
import { tabDotClass, tabNeedsYou } from '../lib/needs-you';
import { TAB_STATE_LABEL, type Machine, type Project, type Tab } from '../lib/types';

interface Props {
  project: Project;
  /** the section showing this row: a running project shows in two, and its lists must be told apart */
  section: string;
  /** the project's open terminal tabs ("agents"), already ordered */
  agents: Tab[];
  /** the project's linked machines: its terminals are listed under the machine each runs on */
  machines: Machine[];
  /** how many of its tabs are waiting for you */
  waiting: number;
  expanded: boolean;
  onToggle: () => void;
  /** the project's chat: its live state and how to open it; null when the user has no chat access */
  chat: { status: { busy: boolean; pending: number }; open: boolean; onToggle: () => void } | null;
  /** in Favoritos: the pin is pressed and always shown */
  favorite: boolean;
  onToggleFavorite: () => void;
  /** opens the "Grupos…" menu under the given button */
  onOpenGroups: (anchor: HTMLElement) => void;
  /** drag-and-drop handlers for moving the row between groups; filled by the sidebar's drag layer */
  dragProps?: HTMLAttributes<HTMLLIElement>;
  /** ends a terminal (kills its session): the ✕ next to it; absent without permission to close terminals */
  onEndTerminal?: (tab: Tab) => void;
}

/** The project's terminals under the machine each runs on, machines in link order (unknown ones last). */
function byMachine(agents: Tab[], machines: Machine[]): { id: string; name: string; tabs: Tab[] }[] {
  const groups = machines.map((m) => ({ id: m.id, name: m.name, tabs: agents.filter((t) => t.machine_id === m.id) }));
  const known = new Set(machines.map((m) => m.id));
  for (const t of agents) {
    if (known.has(t.machine_id)) continue;
    known.add(t.machine_id);
    groups.push({ id: t.machine_id, name: 'outra máquina', tabs: agents.filter((x) => x.machine_id === t.machine_id) });
  }
  return groups.filter((g) => g.tabs.length > 0);
}

/** One project in the sidebar: its link and actions, and its running agents underneath. */
export function ProjectRow({ project: p, section, agents, machines, waiting, expanded, onToggle, chat, favorite, onToggleFavorite, onOpenGroups, dragProps, onEndTerminal }: Props) {
  const navigate = useNavigate();
  const hasAgents = agents.length > 0;
  const editorTabs = useEditorTabs(p.id);
  const listId = useId();
  const pinLabel = favorite ? 'Tirar de Favoritos' : 'Fixar em Favoritos';
  const pin = (
    <button
      type="button"
      className={`rounded px-1 text-xs hover:bg-bg-4 ${favorite ? 'text-accent opacity-70 hover:opacity-100' : 'text-fg-dim opacity-60 grayscale hover:text-fg hover:opacity-100'}`}
      title={pinLabel}
      aria-label={pinLabel}
      aria-pressed={favorite}
      onClick={onToggleFavorite}
    >
      📌
    </button>
  );
  // The 💬 stays visible without hover while that project's chat is answering, waiting on a confirmation,
  // or open in its project window — the same always-shown treatment a favourite's pin gets.
  const chatActive = !!chat && (chat.status.busy || chat.status.pending > 0);
  const chatPinned = !!chat && (chatActive || chat.open);
  const chatButton = chat && (
    <button
      type="button"
      data-active={chatActive}
      className="relative rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg"
      aria-label="Chat do projeto"
      title={chat.status.pending > 0 ? 'Chat do projeto — esperando sua confirmação' : chat.status.busy ? 'Chat do projeto — respondendo' : 'Chat do projeto'}
      onClick={chat.onToggle}
    >
      💬
      {chatActive && <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${chat.status.pending > 0 ? 'bg-attention' : 'animate-pulse bg-accent'}`} />}
    </button>
  );
  return (
    <li {...dragProps} className={`mb-0.5 ${dragProps?.className ?? ''}`}>
      <div className="group/p flex items-center rounded-r hover:bg-bg-3">
        {hasAgents ? (
          <button
            type="button"
            className="w-5 shrink-0 py-1 text-center text-[9px] text-fg-dim hover:text-fg"
            title={expanded ? 'Recolher' : 'Expandir'}
            aria-label={`${expanded ? 'Recolher' : 'Expandir'} agentes de ${p.name}`}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggle}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <NavLink
          to={`/projects/${p.id}`}
          className={({ isActive }) =>
            `flex min-w-0 flex-1 items-center gap-2 rounded-r py-1 pr-3 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted group-hover/p:text-fg'}`
          }
          title={machines.map((m) => m.name).join(', ') || 'sem máquina vinculada'}
        >
          <span className="shrink-0 font-mono text-[10px] text-fg-dim">{p.key}</span>
          <span className={`truncate ${p.status !== 'active' ? 'opacity-60' : ''}`}>{p.name}</span>
          {waiting > 0 && (
            <span
              className="ml-auto h-2 w-2 shrink-0 animate-pulse rounded-full bg-attention"
              title={waiting === 1 ? '1 tab esperando você' : `${waiting} tabs esperando você`}
              aria-label="esperando você"
            />
          )}
          {!!p.open_tasks && p.status === 'active' && (
            <span className={`${waiting ? '' : 'ml-auto '}rounded-full bg-bg-4 px-1.5 text-[10px] tabular-nums text-fg-muted group-hover/p:hidden`} title={`${p.open_tasks} task(s) aberta(s)`}>
              {p.open_tasks}
            </span>
          )}
          {p.status === 'paused' && <span className={`${waiting ? '' : 'ml-auto '}text-[10px] text-warn group-hover/p:hidden`}>pausado</span>}
          {p.status === 'archived' && <span className={`${waiting ? '' : 'ml-auto '}text-[10px] text-fg-dim group-hover/p:hidden`}>arquivado</span>}
        </NavLink>
        {/* a favourite's pin stays visible; the other actions show on hover or while the row has keyboard focus
            (the Grupos… menu is the keyboard path). All outside the link so clicking them does not navigate */}
        {(favorite || chatPinned) && (
          <span className="flex shrink-0 items-center gap-0.5 pr-1 group-focus-within/p:pr-0 group-hover/p:pr-0">
            {chatPinned && chatButton}
            {favorite && pin}
          </span>
        )}
        <span className="hidden shrink-0 items-center gap-0.5 pr-1 group-focus-within/p:flex group-hover/p:flex">
          {!chatPinned && chatButton}
          {!favorite && pin}
          <button
            type="button"
            className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg"
            title="Grupos…"
            aria-label="Grupos…"
            aria-haspopup="menu"
            onClick={(e) => onOpenGroups(e.currentTarget)}
          >
            ⋯
          </button>
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" title="Editar projeto" onClick={() => navigate(`/projects/${p.id}/settings`)}>
            ✎
          </button>
        </span>
      </div>
      {hasAgents && expanded && (
        <ul id={listId} className="ml-4 border-l border-line pl-2" aria-label={`Agentes de ${p.name} · ${section}`}>
          {byMachine(agents, machines).map((m) => (
            <li key={m.id}>
              <div className="truncate px-1 pt-0.5 text-[10px] text-fg-dim" title={m.name}>
                {m.name}
              </div>
              <ul aria-label={`Terminais em ${m.name}`}>
                {m.tabs.map((tab) => {
                  // like a code editor's explorer: a click opens the terminal in the preview tab, a double
                  // click pins it; the ✕ here is the one that ends the terminal (the tab's ✕ only closes the tab)
                  const open = !!editorTabs?.open.includes(tab.id);
                  const preview = editorTabs?.preview === tab.id;
                  const needsYou = tabNeedsYou(tab);
                  return (
                    <li key={tab.id} className="group/t flex min-w-0 items-center rounded hover:bg-bg-3">
                      <Link
                        to={`/projects/${p.id}?tab=${tab.id}`}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5 text-xs ${open ? 'text-fg' : 'text-fg-muted'} hover:text-fg`}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          // what the first click did (preview, in place of the old preview), then pin: the same
                          // result however fast the clicks come, before or after the click's navigation lands
                          updateEditorTabs(p.id, (s) => pinTab(previewTab(s, tab.id), tab.id));
                          navigate(`/projects/${p.id}?tab=${tab.id}`);
                        }}
                        title={`${tab.name}${open ? (preview ? ' · aberta em prévia (duplo clique fixa)' : ' · aba aberta') : ' · clique abre em prévia, duplo clique fixa'}`}
                      >
                        {/* an open tab is a live one here: no state = the neutral dot the tab bar shows */}
                        <span
                          data-dot
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${tabDotClass(true, tab)}`}
                          title={tab.state ? TAB_STATE_LABEL[tab.state] : undefined}
                          aria-label={needsYou ? 'esperando você' : undefined}
                        />
                        <span className={`min-w-0 truncate ${preview ? 'pr-0.5 italic' : ''}`}>{tab.name}</span>
                      </Link>
                      {onEndTerminal && (
                        <button
                          type="button"
                          className="hidden shrink-0 rounded px-1 text-[10px] text-fg-dim hover:bg-bg-4 hover:text-danger group-focus-within/t:block group-hover/t:block"
                          title="Encerrar terminal (mata a sessão tmux)"
                          aria-label={`Encerrar terminal ${tab.name}`}
                          onClick={() => onEndTerminal(tab)}
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
