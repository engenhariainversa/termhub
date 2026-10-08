import { useTranslation } from '../i18n';
import { tabDotClass, tabDotWorking, tabNeedsYou } from '../lib/needs-you';
import type { Tab } from '../lib/types';

interface Props {
  /** the tab's session is up: a dead one is grey whatever it last reported */
  alive: boolean;
  /** the tab's monitor state; null/undefined = it never reported one */
  tab: Pick<Tab, 'state' | 'state_at' | 'state_seen_at'> | null | undefined;
  /** the card ref of the automatic run working in the tab (TER-1044); absent = none */
  autoRef?: string;
  /** the tooltip, before the automatic run's note */
  title?: string;
}

/** "trabalhando (automático, TER-123)": the dot's text with the automatic run's card, when there is one. */
export function withAutoRef(text: string, autoRef: string | undefined, t: ReturnType<typeof useTranslation>['t']): string {
  return autoRef ? t('{{state}} (automático, {{ref}})', { state: text, ref: autoRef }) : text;
}

/**
 * A tab's status dot (TER-1044): its colour, a pulse while it works and a slow blink while it needs you;
 * a tab an automatic run works in also gets a ring around the dot, turning while it works. The motion is
 * CSS only (index.css): none for whoever asked the system for no motion, and none while the page or the
 * list is not on screen, since the browser does not run animations it does not paint.
 */
export function TabDot({ alive, tab, autoRef, title }: Props) {
  const { t } = useTranslation();
  const needsYou = !!tab && tabNeedsYou(tab);
  const label = title ? withAutoRef(title, autoRef, t) : autoRef ? t('automático, {{ref}}', { ref: autoRef }) : undefined;
  // the box is the ring's size, ring or not (TER-1045): the ring and the pulse (6px dot at 1.4×) stay inside
  // it, so nothing around it clips them and a ringed row's text lines up with the others
  return (
    <span
      className="relative inline-flex h-3 w-3 shrink-0 items-center justify-center"
      title={label}
      role={label || needsYou ? 'img' : undefined}
      aria-label={needsYou ? t('esperando você') : label}
    >
      {autoRef && (
        <span
          data-auto-ring
          aria-hidden
          className={`absolute inset-0 rounded-full border border-accent border-r-transparent ${tabDotWorking(alive, tab) ? 'tab-dot-ring' : ''}`}
        />
      )}
      <span data-dot aria-hidden className={`h-1.5 w-1.5 rounded-full ${tabDotClass(alive, tab)}`} />
    </span>
  );
}
