import { useEffect, useRef, useState } from 'react';
import { PRESETS, type Preset } from '../lib/layout';
import { TAB_STATE_LABEL, type Tab } from '../lib/types';
import { tabDotClass } from '../lib/needs-you';
import { useMonitor } from '../lib/monitor';

/** A file preview open in the bar (spec 2026-10-04 file preview D14): same preview, pin and close as a terminal. */
export interface FileBarTab {
  id: string;
  name: string;
  kind: 'file';
  /** the path as the answer wrote it */
  path: string;
}
export type BarTab = Tab | FileBarTab;

interface Props {
  /** the open tabs (TER-904): every terminal of the project is in the sidebar, these are the ones shown here; file previews too */
  tabs: BarTab[];
  activeId: string | null;
  /** the preview tab (italic), reused by the next single click in the sidebar; null = all pinned */
  previewId?: string | null;
  /** pins the preview tab (double click on it, or its 📌) */
  onPin?: (id: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewSimulator?: () => void;
  canSimulator: boolean;
  onRename: (id: string, name: string) => void;
  /** closes the tab only: the terminal keeps running and stays in the sidebar */
  onClose: (id: string) => void;
  preset: Preset;
  onPreset: (p: Preset) => void;
  /** whether the tab is currently on screen (in a cell or floating) */
  onScreen: (tabId: string) => boolean;
  /** small extra text after the tab name (e.g. which machine it runs on), keyed by tab id */
  badges?: Record<string, string>;
}

/** 16×12 glyph of the preset's cell arrangement. */
function PresetIcon({ preset }: { preset: Preset }) {
  const cells: [number, number, number, number][] =
    preset === 'single'
      ? [[0, 0, 16, 12]]
      : preset === 'columns'
        ? [
            [0, 0, 7.5, 12],
            [8.5, 0, 7.5, 12],
          ]
        : preset === 'rows'
          ? [
              [0, 0, 16, 5.5],
              [0, 6.5, 16, 5.5],
            ]
          : preset === 'stack-left'
            ? [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 12],
              ]
            : [
                [0, 0, 7.5, 5.5],
                [0, 6.5, 7.5, 5.5],
                [8.5, 0, 7.5, 5.5],
                [8.5, 6.5, 7.5, 5.5],
              ];
  return (
    <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
      {cells.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

export function TabBar({ tabs, activeId, previewId = null, onPin, onSelect, onNew, onNewSimulator, canSimulator, onRename, onClose, preset, onPreset, onScreen, badges }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { tabState } = useMonitor();

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (editing && draft.trim()) onRename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-bg-2">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const shown = onScreen(t.id);
          const preview = t.id === previewId;
          return (
            <div
              key={t.id}
              className={`group relative flex min-w-[120px] max-w-[220px] cursor-pointer select-none items-center gap-2 border-r border-line px-3 text-xs ${
                active ? 'bg-bg text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'
              }`}
              onClick={() => onSelect(t.id)}
              onDoubleClick={() => {
                // like a code editor: a double click pins a preview tab; on a pinned one it renames
                if (preview && onPin) return onPin(t.id);
                if (t.kind === 'file') return; // a file tab is named after its file
                setEditing(t.id);
                setDraft(t.name);
              }}
              data-preview={preview || undefined}
              title={`${t.kind === 'file' ? t.path : t.name} — ${t.kind === 'file' ? 'arquivo' : t.kind === 'simulator' ? 'simulador iOS' : t.tmux_session}${preview ? ' · prévia (duplo clique fixa)' : ''}${i < 9 ? `  (⌘${i + 1})` : ''}`}
            >
              {(active || shown) && <span className={`absolute inset-x-0 top-0 h-px ${active ? 'bg-accent' : 'bg-accent/40'}`} />}
              {t.kind === 'file' ? (
                <span className="text-[10px]" aria-hidden>
                  📄
                </span>
              ) : (() => {
                const monitorTab = tabState(t.id);
                const st = monitorTab?.state;
                const base = t.kind === 'simulator' ? (t.alive ? 'simulador conectado' : 'simulador desconectado') : t.alive ? 'sessão tmux ativa' : 'sessão tmux não iniciada';
                return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tabDotClass(t.alive, monitorTab)}`} title={st && st !== 'working' ? `${base} · ${TAB_STATE_LABEL[st]}` : base} />;
              })()}
              {t.kind === 'simulator' && (
                <span className="text-[10px]" aria-hidden>
                  📱
                </span>
              )}
              {editing === t.id ? (
                <input
                  ref={inputRef}
                  className="w-full bg-transparent outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className={`truncate ${preview ? 'pr-0.5 italic' : ''}`}>{t.name}</span>
              )}
              {badges?.[t.id] && <span className="ml-1 max-w-[72px] truncate rounded bg-bg-4 px-1 text-[10px] text-fg-dim">{badges[t.id]}</span>}
              {preview && onPin && (
                // the touch path to pin (no double click there), and a hint of what the italic means
                <button
                  className={`ml-auto rounded px-0.5 text-[10px] text-fg-dim hover:bg-bg-4 hover:text-fg ${active ? '' : 'invisible group-hover:visible'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPin(t.id);
                  }}
                  title="Fixar aba (ou dê um duplo clique)"
                  aria-label={`Fixar aba ${t.name}`}
                >
                  📌
                </button>
              )}
              <button
                className={`${preview && onPin ? '' : 'ml-auto '}rounded px-1 text-fg-dim hover:bg-bg-4 hover:text-fg ${active ? '' : 'invisible group-hover:visible'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                title={t.kind === 'file' ? 'Fechar aba (⌘W)' : 'Fechar aba (⌘W) — o terminal continua rodando'}
                aria-label={`Fechar aba ${t.name}`}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button className="px-3 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onNew} title="Nova tab (⌘T)" aria-label="Nova tab">
          +
        </button>
        {canSimulator && (
          <button className="px-2 text-sm text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onNewSimulator} title="Novo simulador iOS" aria-label="Novo simulador iOS">
            📱
          </button>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5 px-2" role="radiogroup" aria-label="Arranjo dos painéis">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            role="radio"
            aria-checked={preset === p.key}
            className={`rounded p-0.5 ${preset === p.key ? 'bg-bg-4 text-fg' : 'text-fg-dim hover:bg-bg-3 hover:text-fg'}`}
            onClick={() => onPreset(p.key)}
            title={p.label}
          >
            <PresetIcon preset={p.key} />
          </button>
        ))}
      </div>
    </div>
  );
}
