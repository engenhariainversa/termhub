import { readFile } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { renderLegal } from './src/legal/render';

/** `import doc from '…/x.md?legal'` → the document rendered to HTML at build time (src/legal/render.ts). */
function legalMarkdown(): Plugin {
  return {
    name: 'termhub-legal-markdown',
    async load(id) {
      if (!id.endsWith('.md?legal')) return null;
      const file = id.slice(0, -'?legal'.length);
      this.addWatchFile(file);
      return `export default ${JSON.stringify(renderLegal(await readFile(file, 'utf8')))};`;
    },
  };
}

// Static marketing site served at termhub.dev (see landing/Dockerfile).
// Multi-page: every adjacent page (/brand/, /security/, /termos/, /privacidade/) is its own
// `<dir>/index.html` entry, so nginx serves it as a plain directory index.
export default defineConfig({
  plugins: [react(), legalMarkdown()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
        brand: 'brand/index.html',
        security: 'security/index.html',
        termos: 'termos/index.html',
        privacidade: 'privacidade/index.html',
      },
    },
  },
  // dev: the waitlist form posts to the API served by the app (npm run dev:server)
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
