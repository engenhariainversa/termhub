import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static marketing site served at termhub.dev (see landing/Dockerfile).
// Multi-page: every adjacent page (/brand/, /security/, /excluir-conta/, later terms and privacy) is its own
// `<dir>/index.html` entry, so nginx serves it as a plain directory index.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
        brand: 'brand/index.html',
        security: 'security/index.html',
        deleteAccount: 'excluir-conta/index.html',
      },
    },
  },
  // dev: the waitlist form posts to the API served by the app (npm run dev:server)
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
