/**
 * The catalogs the public city shows: its own, the office scene's and the common words. Swapped in
 * for `catalogs.ts` by vite.city.config.ts; `city/bundle.test.ts` checks every key the city and the
 * office use has its entry in one of these.
 */
export const catalogFiles = import.meta.glob<{ default: Record<string, string> }>('../locales/*/{city,office,common}.json', { eager: true });
