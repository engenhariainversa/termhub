import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { i18n } from '../i18n';
import type { CityLink } from './types';

export interface CityLinkState {
  link: CityLink | null;
  saving: boolean;
  /** the server's own words for the last refused save (e.g. where a pasted link really points) */
  error: string | null;
  /** true when the link was saved */
  setCustom(shortUrl: string): Promise<boolean>;
  restorePartner(): Promise<void>;
  /** forget the last refusal (the form was opened again, or cancelled) */
  clearError(): void;
}

/**
 * The signed-in person's short link. `active` = they have a nickname: before that there is no city
 * to link to, and nothing is asked. A read that fails leaves `link` null — every caller falls back
 * to the long city address, which always works.
 */
export function useCityLink(active: boolean): CityLinkState {
  const [link, setLink] = useState<CityLink | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setLink(null);
      return;
    }
    let cancelled = false;
    api.auth
      .cityLink()
      .then((l) => {
        if (!cancelled) setLink(l);
      })
      .catch(() => {
        /* the long link stands in */
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const run = useCallback(async (call: () => Promise<CityLink>): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setLink(await call());
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t('Não foi possível salvar. Tente de novo.'));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const setCustom = useCallback((shortUrl: string) => run(() => api.auth.setCustomCityLink(shortUrl)), [run]);
  const restorePartner = useCallback(async () => {
    await run(() => api.auth.clearCustomCityLink());
  }, [run]);

  const clearError = useCallback(() => setError(null), []);

  return { link, saving, error, setCustom, restorePartner, clearError };
}
