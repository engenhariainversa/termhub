import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import { useProjectGroups } from '../lib/project-groups';
import type { ProjectGroup } from '../lib/types';
import { GROUP_NAME_MAX } from './GroupHeader';

interface Props {
  projectId: string;
  /** the button that opened it: the menu sits under it, and a mousedown on it is not "outside" */
  anchor: HTMLElement;
  onClose(): void;
}

const MENU_WIDTH = 208;

/** The keyboard/touch path to groups: a checkbox per group for one project, plus "Novo grupo…". */
export function ProjectGroupsMenu({ projectId, anchor, onClose }: Props) {
  const { t } = useTranslation();
  const { groups, setMemberships, createGroup } = useProjectGroups();
  const ref = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  // measured once: unchecking the group the row sits in unmounts the anchor, and a detached element measures 0×0
  const [pos] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    return { top: rect.bottom + 2, left: Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)) };
  });
  const latestClose = useRef(onClose);
  latestClose.current = onClose;

  // keyboard path: start on the first group, and hand focus back to the ⋯ button on Esc
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      latestClose.current();
      if (anchor.isConnected) anchor.focus();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      latestClose.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [anchor]);

  // Favoritos first, then the user's groups in sidebar order
  const ordered = [...groups].sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === 'favorites' ? -1 : 1));

  const toggle = (g: ProjectGroup) => {
    const project_ids = g.project_ids.includes(projectId) ? g.project_ids.filter((id) => id !== projectId) : [...g.project_ids, projectId];
    void setMemberships(
      groups.map((x) => (x.id === g.id ? { ...x, project_ids } : x)),
      [{ id: g.id, project_ids }],
    );
  };

  const create = async () => {
    const name = draft.trim();
    if (!name || name.length > GROUP_NAME_MAX) return;
    setCreating(false);
    setDraft('');
    const group = await createGroup(name);
    if (!group) return;
    const project_ids = [...group.project_ids.filter((id) => id !== projectId), projectId];
    const added = { ...group, project_ids };
    // `groups` is from before the create: add the new group rather than dropping it from the next state
    const next = groups.some((g) => g.id === group.id) ? groups.map((g) => (g.id === group.id ? added : g)) : [...groups, added];
    await setMemberships(next, [{ id: group.id, project_ids }]);
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('Grupos')}
      className="fixed z-50 rounded-md border border-line bg-bg-2 py-1 text-xs shadow-xl"
      style={{ ...pos, width: MENU_WIDTH }}
    >
      {ordered.map((g) => {
        const checked = g.project_ids.includes(projectId);
        return (
          <button
            key={g.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={checked}
            className="flex w-full items-center gap-2 px-3 py-1 text-left text-fg-muted hover:bg-bg-3 hover:text-fg"
            onClick={() => toggle(g)}
          >
            <span className="w-3 shrink-0 text-accent" aria-hidden="true">
              {checked ? '✓' : ''}
            </span>
            <span className="truncate">{g.kind === 'favorites' ? t('Favoritos') : g.name}</span>
          </button>
        );
      })}
      <div className="my-1 border-t border-line" />
      {creating ? (
        <div className="px-2 py-1">
          <input
            className="input px-2 py-1 text-xs"
            aria-label={t('Nome do novo grupo')}
            placeholder={t('Nome do grupo')}
            value={draft}
            maxLength={GROUP_NAME_MAX}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
          />
        </div>
      ) : (
        <button type="button" role="menuitem" className="w-full px-3 py-1 text-left text-fg-muted hover:bg-bg-3 hover:text-fg" onClick={() => setCreating(true)}>
          {t('Novo grupo…')}
        </button>
      )}
    </div>
  );
}
