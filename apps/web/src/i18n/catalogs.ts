/**
 * Every catalog file, for the app. The public city build swaps this module for `catalogs-city.ts`
 * (vite.city.config.ts), so the street bundle carries only the copy it shows.
 */
export const catalogFiles = import.meta.glob<{ default: Record<string, string> }>('../locales/*/*.json', { eager: true });
