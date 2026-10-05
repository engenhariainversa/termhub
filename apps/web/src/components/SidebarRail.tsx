import { ArrowLeft, ChevronsRight } from 'lucide-react';
import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { useProjectGroups } from '../lib/project-groups';
import { favoriteProjects } from '../lib/project-groups-model';
import { projectInitials } from '../lib/project-initials';
import { visibleSettingsSections } from '../lib/settings-sections';
import { MainNav } from './MainNav';
import { ProfileButton } from './ProfileButton';
import { SETTINGS_ICONS } from './settings-icons';

const SQUARE = 'flex h-8 w-8 shrink-0 items-center justify-center rounded';
const IDLE = 'text-fg-muted hover:bg-bg-3 hover:text-fg';

/**
 * The collapsed sidebar (spec 2026-09-23 app chrome §5), 48 px wide: logo and expand, then the
 * Favoritos projects as two-letter squares, the daily menus as icons and the avatar. Under /settings
 * it lists the settings sections as icons, with a way back, instead of the projects.
 */
export function SidebarRail({ mode, onExpand, onBack }: { mode: 'main' | 'settings'; onExpand: () => void; onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <aside aria-label={t('Sidebar recolhida')} className="flex h-full w-12 shrink-0 flex-col items-center border-r border-line bg-bg-2">
      <NavLink
        to="/"
        className="flex h-11 w-full shrink-0 items-center justify-center border-b border-line text-sm font-semibold text-accent"
        title={t('termhub — início')}
        aria-label={t('termhub — início')}
      >
        ▮
      </NavLink>
      <button type="button" className={`mt-1 ${SQUARE} text-fg-dim hover:bg-bg-3 hover:text-fg`} onClick={onExpand} title={t('Mostrar sidebar')} aria-label={t('Mostrar sidebar')}>
        <ChevronsRight size={18} aria-hidden="true" />
      </button>
      {mode === 'settings' ? <SettingsRail onBack={onBack} /> : <MainRail />}
    </aside>
  );
}

function MainRail() {
  const { t } = useTranslation();
  const { projects } = useData();
  const { groups } = useProjectGroups();
  const { items } = useMonitor();
  const favorites = useMemo(() => favoriteProjects(projects, groups), [projects, groups]);
  const waiting = useMemo(() => needsYouByProject(items), [items]);
  return (
    <>
      <div className="mt-1 min-h-0 w-full flex-1 overflow-y-auto">
        {favorites.length > 0 && (
          <nav aria-label={t('Favoritos')} className="flex flex-col items-center gap-1 border-t border-line py-2">
            {favorites.map((p) => {
              const needsYou = (waiting.get(p.id) ?? 0) > 0;
              const label = needsYou ? t('{{name}}, precisa de você', { name: p.name }) : p.name;
              return (
                <NavLink
                  key={p.id}
                  to={`/projects/${p.id}`}
                  aria-label={label}
                  title={label}
                  className={({ isActive }) => `relative ${SQUARE} text-[11px] font-semibold ${isActive ? 'bg-accent/20 text-fg ring-1 ring-accent' : `bg-bg-3 ${IDLE}`}`}
                >
                  {projectInitials(p.name)}
                  {needsYou && <i data-attention aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-attention" />}
                </NavLink>
              );
            })}
          </nav>
        )}
      </div>
      <MainNav variant="rail" />
      <ProfileButton variant="rail" />
    </>
  );
}

function SettingsRail({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  return (
    <>
      <button type="button" className={`mt-1 ${SQUARE} ${IDLE}`} onClick={onBack} title={t('Voltar (Esc)')} aria-label={t('Voltar de Configurações')} data-chrome-focus="settings-back">
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <nav aria-label={t('Seções de Configurações')} className="mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto border-t border-line py-2">
        {visibleSettingsSections(can).map((s) => {
          const Icon = SETTINGS_ICONS[s.key];
          return (
            <NavLink key={s.key} to={`/settings/${s.key}`} aria-label={t(s.label)} title={t(s.label)} className={({ isActive }) => `${SQUARE} ${isActive ? 'bg-bg-4 text-fg' : IDLE}`}>
              <Icon size={18} aria-hidden="true" />
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}
