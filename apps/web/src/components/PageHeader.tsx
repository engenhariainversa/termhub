import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from '../i18n';

export interface PageHeaderTab {
  to: string;
  label: string;
  /** match the address exactly (a tab whose address is a prefix of its siblings', like `/`) */
  end?: boolean;
  /** a small count after the label (the project's open tasks) */
  badge?: number;
}

export interface PageHeaderProps {
  title: string;
  /** short context next to the title, truncated; a long explanation goes at the top of the content instead */
  subtitle?: string;
  /** the subtitle's tooltip, when it has more to say than the subtitle itself (the project's cwd per machine) */
  subtitleTitle?: string;
  tabs?: PageHeaderTab[];
  /** content between the tabs and the actions (the office's Cidade › máquina › sala trail) */
  extra?: ReactNode;
  /** right-aligned buttons ("+ máquina", "Convidar") */
  actions?: ReactNode;
}

/** titles up to this many characters fit the 6rem floor at text-sm, so they never shrink */
const SHORT_TITLE = 12;

/**
 * The one header every page inside the sidebar layout uses (spec 2026-09-23 app chrome §6). The bar
 * itself never clips its overflow: popovers anchored in the actions (PublishControl) hang below it.
 * On a narrow window things give way in order: the subtitle first (hidden below `lg`), then a long
 * title (truncated, never below 6rem, no fixed cap), and the middle — tabs and extra — last, never
 * below a usable width, scrolling sideways with both edges faded. A short title never shrinks (CSS
 * cannot say "min-width: min(6rem, max-content)", so a title short enough to fit 6rem is simply
 * `shrink-0`). The actions never shrink.
 */
export function PageHeader({ title, subtitle, subtitleTitle, tabs, extra, actions }: PageHeaderProps) {
  const { t } = useTranslation();
  const hasTabs = !!tabs && tabs.length > 0;
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg-2 px-4">
      <h1 className={`${Array.from(title).length <= SHORT_TITLE ? 'shrink-0' : 'min-w-[6rem] shrink-[2]'} truncate text-sm font-semibold`} title={title}>
        {title}
      </h1>
      {subtitle && (
        <span className="hidden min-w-0 shrink-[10] truncate text-xs text-fg-muted lg:inline" title={subtitleTitle ?? subtitle}>
          {subtitle}
        </span>
      )}
      {(hasTabs || extra) && (
        <div className="header-scroll-fade flex min-w-[10rem] flex-1 shrink basis-auto items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {hasTabs && (
            <nav aria-label={t('Seções de {{title}}', { title })} className="flex shrink-0 items-center gap-1">
              {tabs!.map((tab) => (
                <NavLink
                  key={tab.to}
                  to={tab.to}
                  end={tab.end}
                  className={({ isActive }) => `whitespace-nowrap rounded px-3 py-1 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
                >
                  {tab.label}
                  {!!tab.badge && <span className="ml-1 text-[10px] text-fg-dim">{tab.badge}</span>}
                </NavLink>
              ))}
            </nav>
          )}
          {extra && <div className="flex shrink-0 items-center whitespace-nowrap text-xs text-fg-muted">{extra}</div>}
        </div>
      )}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A page made of the shared header and a scrolling, padded body. */
export function PageFrame({ children, ...header }: PageHeaderProps & { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader {...header} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
