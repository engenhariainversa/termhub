import { ArrowLeft, ChevronsLeft } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { settingsGroups } from '../lib/settings-sections';
import { SETTINGS_ICONS } from './settings-icons';

const GROUP_LABEL = 'px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-fg-dim';

/**
 * Configurações as a sidebar (spec 2026-09-23 app chrome §4): it takes the projects sidebar's place
 * under /settings, sliding in, and lists the sections under Conta and Administração — a heading shows
 * only when something under it does. Going back (this button, or Esc through the layout) returns to
 * the last page outside settings.
 */
export function SettingsSidebar({ onBack, onCollapse }: { onBack: () => void; onCollapse?: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <aside aria-label={t('Configurações')} className="chrome-slide-in flex h-full w-64 shrink-0 flex-col border-r border-line bg-bg-2">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-2">
        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-1 text-sm font-semibold hover:bg-bg-3"
          onClick={onBack}
          title={t('Voltar (Esc)')}
          aria-label={t('Voltar de Configurações')}
          data-chrome-focus="settings-back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t('Configurações')}
        </button>
        {onCollapse && (
          <button type="button" className="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onCollapse} title={t('Recolher sidebar')} aria-label={t('Recolher sidebar')}>
            <ChevronsLeft size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav aria-label={t('Seções de Configurações')} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {settingsGroups(can).map((g) => (
          <div key={g.id} role="group" aria-labelledby={`settings-group-${g.id}`} className="mb-2">
            <p id={`settings-group-${g.id}`} className={GROUP_LABEL}>
              {t(g.label)}
            </p>
            {g.sections.map((s) => {
              const Icon = SETTINGS_ICONS[s.key];
              return (
                <NavLink
                  key={s.key}
                  to={`/settings/${s.key}`}
                  className={({ isActive }) => `flex items-center gap-2 rounded px-3 py-1.5 text-sm ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {t(s.label)}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
