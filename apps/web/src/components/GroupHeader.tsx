import { useEffect, useRef, useState, type HTMLAttributes } from 'react';
import { useTranslation } from '../i18n';
import type { Section } from '../lib/project-groups-model';

export const GROUP_NAME_MAX = 40;

interface Props {
  section: Section;
  /** the section's accessible name when it differs from its label (two groups with the same name) */
  name?: string;
  collapsed: boolean;
  onToggle(): void;
  /** custom groups only: Favoritos and Outros can be neither renamed nor deleted */
  editable: boolean;
  onRename(name: string): void;
  onDelete(): void;
  /** the rename input closed, saved or not */
  onEditEnd?(): void;
  /** opens the rename input when it turns true (a group just created by "+ grupo") */
  startEditing?: boolean;
  /** drag-and-drop handlers for reordering groups; filled by the sidebar's drag layer */
  headerDragProps?: HTMLAttributes<HTMLDivElement>;
}

/** A collapsible sidebar section header: chevron, name, count and, for custom groups, rename/delete. */
export function GroupHeader({ section, name, collapsed, onToggle, editable, onRename, onDelete, onEditEnd, startEditing, headerDragProps }: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.label);
  // Enter and blur both save: whichever comes first ends the edit, the other is ignored
  const closed = useRef(false);

  const begin = () => {
    closed.current = false;
    setDraft(section.label);
    setEditing(true);
  };
  useEffect(() => {
    if (startEditing && editable) begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing, editable]);

  const finish = (save: boolean) => {
    if (closed.current) return;
    closed.current = true;
    setEditing(false);
    const name = draft.trim();
    if (save && name && name.length <= GROUP_NAME_MAX && name !== section.label) onRename(name);
    onEditEnd?.();
  };

  const label = collapsed ? t('Expandir {{name}}', { name: name ?? section.label }) : t('Recolher {{name}}', { name: name ?? section.label });
  return (
    <div
      {...headerDragProps}
      className={`group/g flex items-center pr-2 ${headerDragProps?.className ?? ''}`}
      // a drag would steal the rename input's text selection
      draggable={headerDragProps?.draggable ? !editing : undefined}
    >
      <button
        type="button"
        className="w-5 shrink-0 py-1 text-center text-[9px] text-fg-dim hover:text-fg"
        title={label}
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? '▶' : '▼'}
      </button>
      {editing ? (
        <input
          className="input min-w-0 flex-1 px-1 py-0 text-xs"
          aria-label={t('Nome do grupo')}
          value={draft}
          maxLength={GROUP_NAME_MAX}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
        />
      ) : (
        <p className="flex min-w-0 flex-1 items-baseline gap-1 py-1 text-[10px] uppercase tracking-wide text-fg-dim">
          <span className="truncate">{section.label}</span>
          <span className="shrink-0 tabular-nums">· {section.projects.length}</span>
        </p>
      )}
      {editable && !editing && (
        <span className="hidden shrink-0 items-center gap-0.5 group-focus-within/g:flex group-hover/g:flex">
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" title={t('Renomear grupo')} onClick={begin}>
            ✎
          </button>
          <button type="button" className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title={t('Excluir grupo')} onClick={onDelete}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}
