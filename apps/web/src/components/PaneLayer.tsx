import type { Preset, Rect } from '../lib/layout';
import type { BarTab } from './TabBar';
import { useTranslation } from '../i18n';

export const PANE_HEADER_HEIGHT = 24;

interface Props {
  preset: Preset;
  rects: Rect[];
  cells: (string | null)[];
  focusedCell: number;
  tabs: BarTab[];
  onFocus: (cell: number) => void;
  onAssign: (cell: number, tabId: string) => void;
  onClear: (cell: number) => void;
  onNewTerminal: (cell: number) => void;
}

/** Dropdown listing every tab of the project plus a "new terminal" entry. */
function TabPicker({ tabs, value, onPick, onNew }: { tabs: BarTab[]; value: string | null; onPick: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <select
      className="h-5 max-w-[180px] rounded border border-line bg-bg px-1 text-[11px] text-fg"
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__new__') onNew();
        else if (e.target.value) onPick(e.target.value);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={t('Aba deste painel')}
    >
      <option value="">{t('Escolha uma aba…')}</option>
      {tabs.map((tab) => (
        <option key={tab.id} value={tab.id}>
          {tab.kind === 'simulator' ? '📱 ' : tab.kind === 'file' ? '📄 ' : tab.kind === 'chat' ? '💬 ' : ''}
          {tab.name}
        </option>
      ))}
      <option value="__new__">{t('+ novo terminal')}</option>
    </select>
  );
}

/**
 * Overlay above the tab wrappers: one header strip per cell (name, picker, clear) and a focus
 * border. Empty cells get a centered picker. Everything else is pointer-transparent so the
 * terminals underneath keep receiving events.
 */
export function PaneLayer({ preset, rects, cells, focusedCell, tabs, onFocus, onAssign, onClear, onNewTerminal }: Props) {
  const { t } = useTranslation();
  if (preset === 'single') return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {rects.map((r, cell) => {
        const tab = cells[cell] ? tabs.find((x) => x.id === cells[cell]) : undefined;
        const focused = cell === focusedCell;
        return (
          <div
            key={cell}
            className={`absolute ${focused ? 'ring-1 ring-inset ring-accent/60' : 'ring-1 ring-inset ring-line'}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
          >
            <div
              className="pointer-events-auto flex items-center gap-2 border-b border-line bg-bg-2 px-2 text-[11px] text-fg-muted"
              style={{ height: PANE_HEADER_HEIGHT }}
              onPointerDown={() => onFocus(cell)}
            >
              {tab ? (
                <>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab.kind === 'file' || tab.kind === 'chat' || tab.alive ? 'bg-ok' : 'bg-fg-dim'}`} />
                  <span className="truncate text-fg">{tab.name}</span>
                  <TabPicker tabs={tabs} value={tab.id} onPick={(id) => onAssign(cell, id)} onNew={() => onNewTerminal(cell)} />
                  <button
                    className="ml-auto rounded px-1 text-fg-dim hover:bg-bg-4 hover:text-fg"
                    onClick={() => onClear(cell)}
                    title={t('Tirar deste painel (a aba continua na barra)')}
                    aria-label={t('Esvaziar painel')}
                  >
                    ✕
                  </button>
                </>
              ) : (
                <span className="text-fg-dim">{t('Painel vazio')}</span>
              )}
            </div>
            {!tab && (
              <div
                className="pointer-events-auto flex flex-col items-center justify-center gap-2 text-sm text-fg-muted"
                style={{ height: r.h - PANE_HEADER_HEIGHT }}
                onPointerDown={() => onFocus(cell)}
              >
                <p>{t('Escolha uma aba')}</p>
                <TabPicker tabs={tabs} value={null} onPick={(id) => onAssign(cell, id)} onNew={() => onNewTerminal(cell)} />
                <button className="btn-ghost text-xs" onClick={() => onNewTerminal(cell)}>
                  {t('+ terminal')}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
