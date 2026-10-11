import { useCallback, useState } from 'react';
import { BetaForm } from './BetaForm';
import { tk, useTranslation } from '../i18n';

/** Where a visitor learns what termhub is. */
export const LANDING_URL = 'https://termhub.dev/';

/** Set once the visitor collapses the card; absent means "open it", which is every first visit. */
const COLLAPSED_KEY = 'termhub:city-beta-collapsed';

/**
 * Storage is a convenience here, never a requirement: a private window, blocked site data or a
 * sandboxed preview can make the accessor itself throw, and the card must behave the same without
 * it — open on arrival, collapsing for this visit only.
 */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSED_KEY, '1');
    else window.localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* no storage: the choice lasts as long as the page */
  }
}

/** Whether the beta card is open, remembered across visits: collapsing it sticks, reopening it clears that. */
export function useBetaCard(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => !readCollapsed());
  const set = useCallback((next: boolean) => {
    writeCollapsed(!next);
    setOpen(next);
  }, []);
  return [open, set];
}

const BENEFITS = [
  tk('Terminais que não morrem: feche o navegador e o shell continua.'),
  tk('Todas as suas máquinas e agentes num só lugar.'),
  tk('Aviso no celular quando o agente precisa de você.'),
];

/**
 * The invitation a visitor gets on somebody else's city: what they are looking at, why they would
 * want one, and the beta sign-up itself. `ownerName` null is the generic wording (the city is still
 * loading, or there is no city at all); `onCollapse` absent means the card cannot be put away;
 * `className` carries the shape, which differs between a floating card and a bottom sheet.
 */
export function BetaCard({ ownerName, onCollapse, className = 'rounded-lg border' }: { ownerName: string | null; onCollapse?: () => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="beta-title" className={`${className} border-line bg-bg-2/95 p-4 text-left shadow-2xl shadow-black/40 backdrop-blur`}>
      <div className="mb-2 flex items-start gap-2">
        <h2 id="beta-title" className="text-sm font-semibold text-fg">
          {/* i18n-ignore */}
          termhub · <span className="text-accent">{t('beta gratuito')}</span>
        </h2>
        {onCollapse && (
          <button type="button" onClick={onCollapse} aria-label={t('Recolher')} title={t('Recolher')} className="-mr-1 -mt-1 ml-auto rounded px-1.5 text-lg leading-none text-fg-muted hover:bg-bg-3 hover:text-fg">
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <p className="text-sm text-fg-muted">
        {ownerName
          ? t('Você está vendo os agentes de IA de {{name}} trabalhando ao vivo — cada robô é um terminal de verdade.', { name: ownerName })
          : t('Numa cidade do termhub, os agentes de IA trabalham ao vivo — cada robô é um terminal de verdade.')}
      </p>
      <ul className="my-3 space-y-1 text-xs text-fg">
        {BENEFITS.map((b) => (
          <li key={b} className="flex gap-2">
            <span className="text-accent" aria-hidden="true">
              ✓
            </span>
            <span>{t(b)}</span>
          </li>
        ))}
      </ul>
      <BetaForm />
      <a href={LANDING_URL} className="mt-3 inline-block text-xs text-accent hover:underline">
        {t('Conheça o termhub →')}
      </a>
    </section>
  );
}

/**
 * The invitation on a phone before it is asked for: one line at the bottom of the screen instead of
 * the whole form, so the city stays in view. "Quero participar" opens the full card.
 */
export function BetaTeaser({ ownerName, onExpand, onCollapse }: { ownerName: string | null; onExpand: () => void; onCollapse: () => void }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('Convite para o beta')} className="flex items-center gap-2 border-t border-line bg-bg-2/95 px-3 py-2 shadow-2xl shadow-black/40 backdrop-blur">
      <p className="min-w-0 flex-1 truncate text-xs text-fg-muted">
        {ownerName ? t('Agentes de IA de {{name}} ao vivo.', { name: ownerName }) : t('Agentes de IA ao vivo.')} <span className="text-fg">{t('Beta grátis.')}</span>
      </p>
      <button type="button" onClick={onExpand} className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover">
        {t('Quero participar')}
      </button>
      <button type="button" onClick={onCollapse} aria-label={t('Fechar convite')} title={t('Fechar convite')} className="shrink-0 rounded px-1.5 text-lg leading-none text-fg-muted hover:bg-bg-3 hover:text-fg">
        <span aria-hidden="true">×</span>
      </button>
    </section>
  );
}
