import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { track } from './analytics';
import { readStoredLocale, setLocale as applyLocale, type Locale } from '../i18n';
import type { AuthConfig, LegalStatus, User, ViewAs } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  config: AuthConfig | null;
  login: (email: string, password: string) => Promise<void>;
  sendCode: (email: string) => Promise<number>;
  verifyCode: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /** admin data-scope switch (see ViewAs); null when viewing own data */
  viewAs: ViewAs;
  /** admin only: switch the data scope and reload the app so every list/socket follows */
  setViewAs: (user_id: string | null) => Promise<void>;
  /** true when the signed-in user's role grants resource:action (admins: always) */
  can: (resource: string, action?: 'create' | 'read' | 'update' | 'delete' | 'write') => boolean;
  /** claims the signed-in user's public-city nickname; rejects with ApiError (400/409) on refusal */
  setNickname: (nickname: string) => Promise<void>;
  /** where this instance's public cities live (from the server, never a hardcoded host); null until known */
  publicCityUrl: string | null;
  /** refetches /auth/me (e.g. after cancelling a pending account deletion) */
  refresh: () => Promise<void>;
  /** the account's language choice (null = automatic): applied at once, kept in this browser and saved on the account */
  setLocale: (locale: Locale | null) => Promise<void>;
  /** Terms/Privacy versions this person still has to accept, and the ones coming (TER-742); empty lists until known */
  legal: LegalStatus;
  /** replaces `legal` with the status an accept answered */
  setLegal: (legal: LegalStatus) => void;
  /** refetches GET /legal/status */
  refreshLegal: () => Promise<void>;
}

export const NO_LEGAL: LegalStatus = { pending: [], upcoming: [] };

/** A server older than TER-742 sends no `legal`: nothing to accept. */
function legalOf(status: Partial<LegalStatus> | null | undefined): LegalStatus {
  return { pending: status?.pending ?? [], upcoming: status?.upcoming ?? [] };
}

/**
 * The account's language wins over this browser's: someone who picked English elsewhere sees English
 * here too. A server older than the i18n release sends no `locale` at all; then the browser's own
 * choice stays as it is.
 */
function followAccountLocale(user: User | null | undefined) {
  if (!user || !('locale' in user) || user.locale === undefined) return;
  const choice = user.locale ?? null;
  if (choice !== readStoredLocale()) applyLocale(choice);
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [viewAs, setViewAsState] = useState<ViewAs>(null);
  const [loading, setLoading] = useState(true);
  const [legal, setLegalState] = useState<LegalStatus>(NO_LEGAL);

  const setLegal = useCallback((next: LegalStatus) => setLegalState(legalOf(next)), []);
  // A login answers only the user: the acceptance status comes from its own route. A failure leaves
  // the lists empty (the server keeps the record; the gate shows on the next start-up).
  const refreshLegal = useCallback(async () => {
    try {
      setLegalState(legalOf(await api.legal.status()));
    } catch {
      // keep what we had
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, me] = await Promise.all([
          api.auth.config().catch(() => null),
          api.auth.me().catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setUser(me?.user ?? null);
        followAccountLocale(me?.user);
        setViewAsState(me?.view_as ?? null);
        setLegalState(legalOf(me?.legal));
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const onUnauthorized = () => setUser(null);
    // A 403 ACCOUNT_PENDING_DELETION: the deletion was asked elsewhere; the fresh user carries the
    // date, and AppShell swaps the app for the pending-deletion page.
    const onPendingDeletion = () => {
      void api.auth.me().then(
        (me) => !cancelled && setUser(me.user),
        () => {},
      );
    };
    window.addEventListener('termhub:unauthorized', onUnauthorized);
    window.addEventListener('termhub:pending-deletion', onPendingDeletion);
    return () => {
      cancelled = true;
      window.removeEventListener('termhub:unauthorized', onUnauthorized);
      window.removeEventListener('termhub:pending-deletion', onPendingDeletion);
    };
  }, []);

  const can = useCallback(
    (resource: string, action: 'create' | 'read' | 'update' | 'delete' | 'write' = 'read') => {
      if (!user) return false;
      if (user.role_info?.is_admin) return true;
      return (user.permissions ?? []).includes(`${resource}:${action}`);
    },
    [user],
  );

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await api.auth.login(email, password);
    followAccountLocale(user);
    await refreshLegal();
    setUser(user);
    track('login', { method: 'password' });
  }, [refreshLegal]);

  const sendCode = useCallback(async (email: string) => {
    const r = await api.auth.sendCode(email);
    return r.ttl_minutes;
  }, []);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const { user } = await api.auth.verifyCode(email, code);
    followAccountLocale(user);
    await refreshLegal();
    setUser(user);
    track('login', { method: 'code' });
  }, [refreshLegal]);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    setUser(null);
    setViewAsState(null);
    setLegalState(NO_LEGAL);
  }, []);

  const setViewAs = useCallback(async (user_id: string | null) => {
    const r = await api.auth.viewAs(user_id);
    setViewAsState(r.view_as);
    // Machines, projects and open terminals are all scope-bound: a full reload is the honest reset.
    window.location.assign('/');
  }, []);

  const setNickname = useCallback(async (nickname: string) => {
    const { user } = await api.auth.setNickname(nickname);
    setUser(user);
  }, []);

  const setLocale = useCallback(async (locale: Locale | null) => {
    const previous = readStoredLocale();
    applyLocale(locale);
    try {
      await api.auth.setLocale(locale);
      setUser((u) => (u ? { ...u, locale } : u));
    } catch (err) {
      // the screen goes back to what the account still holds, and the caller shows why
      applyLocale(previous);
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    const me = await api.auth.me();
    setUser(me.user);
    setViewAsState(me.view_as);
    setLegalState(legalOf(me.legal));
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, config, login, sendCode, verifyCode, logout, viewAs, setViewAs, can, setNickname, publicCityUrl: config?.public_city_url ?? null, refresh, setLocale, legal, setLegal, refreshLegal }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}
