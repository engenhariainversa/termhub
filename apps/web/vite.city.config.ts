import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const cityCatalogs = fileURLToPath(new URL('./src/i18n/catalogs-city.ts', import.meta.url));

/** The street shows a few screens: load only their catalogs (src/i18n/catalogs-city.ts), not the whole app's copy. */
const cityCatalogsOnly: Plugin = {
  name: 'termhub-city-catalogs',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './catalogs' && importer?.replace(/\\/g, '/').endsWith('/src/i18n/index.ts')) return cityCatalogs;
    return null;
  },
};

/** The public city: the same scene, built on its own with base /city/ so it never shares an asset path with the app or the landing. */
export default defineConfig({
  base: '/city/',
  plugins: [cityCatalogsOnly, react()],
  build: { outDir: 'dist-city', sourcemap: false, rollupOptions: { input: 'index-city.html' } },
});
