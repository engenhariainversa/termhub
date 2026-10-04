import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ANALYTICS_ENABLED, disableAnalytics, initAnalytics, setLang as setAnalyticsLang, track } from './analytics';
import { CookieBanner } from './CookieBanner';
import { readConsent, subscribeConsent } from './consent';
import { DICT, LANG_KEY, LangContext, detectLang, useLang, type Dict, type Lang } from './i18n';

/**
 * What every page of termhub.dev shares: the language switch, analytics and
 * the cookie banner (`Site`), plus the header and footer chrome. The home
 * page and the adjacent ones (/brand/, /security/, /excluir-conta/, later terms and privacy) are separate
 * Vite entries, so each mounts its own tree inside a `Site`.
 */

export const APP_URL = 'https://app.termhub.dev';
export const REPO_URL = 'https://github.com/engenhariainversa/termhub';
export const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

/** Click handler for the site's calls to action; the navigation itself is untouched. */
export const trackCta = (target: string, location: string) => () => track('cta_click', { target, location });

const CookiesContext = createContext<{ openCookies: () => void }>({ openCookies: () => {} });

export function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src="/logo.svg" alt="termhub" className={className} />;
}

export function Chevron() {
  return <span aria-hidden="true">›</span>;
}

function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <span className="flex rounded-field border border-border-2 p-0.5 text-caption" role="group" aria-label="Language">
      {(['pt', 'en'] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`hover-tint tap px-2 py-0.5 font-medium uppercase ${lang === l ? 'bg-surface text-white' : 'text-muted hover:text-frost'}`}
          aria-pressed={lang === l}
        >
          {l}
        </button>
      ))}
    </span>
  );
}

/** Sticky header. `nav` is the page's own link list; the logo always goes back to the home page. */
export function SiteHeader({ nav }: { nav?: ReactNode }) {
  const { t } = useLang();
  return (
    <header className="sticky top-0 z-20 bg-canvas/85 shadow-rim backdrop-blur">
      <div className="mx-auto flex h-14 max-w-page items-center px-4 md:px-6">
        <a href="/" aria-label="termhub" className="hover-tint tap min-w-0 shrink px-1 py-1">
          {/* on the narrowest phones the logo gives way, so the button next to it stays on one line */}
          <Logo className="h-7 w-auto max-w-full object-contain object-left" />
        </a>
        {nav && <nav className="ml-6 hidden items-center gap-1 md:flex">{nav}</nav>}
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <LangSwitch />
          <a href={REPO_URL} className="btn-ghost hidden px-4 py-1.5 text-body-sm md:inline-flex" onClick={trackCta('github', 'nav')}>{t.hero.repo}</a>
          <a href={APP_URL} className="btn-primary whitespace-nowrap px-4 py-1.5 text-body-sm" onClick={trackCta('app', 'nav')}>{t.nav.app}</a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  const { t } = useLang();
  const { openCookies } = useContext(CookiesContext);
  return (
    <footer className="border-t border-border-2">
      <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 coarse:gap-y-6 text-caption text-muted md:px-6">
        <span>© {new Date().getFullYear()} termhub · MIT</span>
        <a href={REPO_URL} className="hover-tint tap px-1.5 py-0.5 hover:text-frost">GitHub</a>
        <a href={`${REPO_URL}/blob/main/README.md`} className="hover-tint tap px-1.5 py-0.5 hover:text-frost">{t.footer.docs}</a>
        <a href="/security/" className="hover-tint tap px-1.5 py-0.5 hover:text-frost">{t.footer.security}</a>
        <a href="/brand/" className="hover-tint tap px-1.5 py-0.5 hover:text-frost">{t.footer.brand}</a>
        <a href="/excluir-conta/" className="hover-tint tap px-1.5 py-0.5 hover:text-frost">{t.footer.deleteAccount}</a>
        <a href={COFFEE_URL} className="hover-tint tap px-1.5 py-0.5 hover:text-frost">{t.footer.coffee}</a>
        {ANALYTICS_ENABLED && (
          <button type="button" onClick={openCookies} className="hover-tint tap px-1.5 py-0.5 hover:text-frost">
            {t.footer.cookies}
          </button>
        )}
        <span className="ml-auto">{t.footer.made}</span>
      </div>
    </footer>
  );
}

/**
 * Language, document metadata, analytics and the cookie banner for one page.
 * `meta` picks the page's title/description out of the dictionary, so the
 * `<title>` follows the language switch.
 */
export function Site({ meta, children }: { meta: (t: Dict) => { title: string; description: string }; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);
  // open until the visitor answers; the footer "Cookies" button reopens it to change the choice
  const [cookiesOpen, setCookiesOpen] = useState(() => ANALYTICS_ENABLED && readConsent() === null);
  const setLang = (l: Lang) => {
    if (l !== lang) {
      setAnalyticsLang(l);
      track('lang_switch', { lang: l });
    }
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    const m = meta(DICT[lang]);
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    document.title = m.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', m.description);
  }, [lang, meta]);
  // analytics starts only with a stored "granted"; withdrawing it stops collection at once,
  // without waiting for the next page load
  useEffect(() => {
    if (readConsent() === 'granted') initAnalytics(lang);
    return subscribeConsent((consent) => {
      setCookiesOpen(false);
      if (consent === 'granted') initAnalytics(lang);
      else disableAnalytics();
    });
  }, [lang]);
  return (
    <LangContext.Provider value={{ lang, t: DICT[lang], setLang }}>
      <CookiesContext.Provider value={{ openCookies: () => setCookiesOpen(true) }}>
        {children}
        {ANALYTICS_ENABLED && <CookieBanner open={cookiesOpen} />}
      </CookiesContext.Provider>
    </LangContext.Provider>
  );
}
