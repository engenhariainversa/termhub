/// <reference types="vite/client" />

/** Firebase Analytics config, injected at build time (docker compose build args). */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string | undefined;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string | undefined;
  readonly VITE_FIREBASE_PROJECT_ID: string | undefined;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string | undefined;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string | undefined;
  readonly VITE_FIREBASE_APP_ID: string | undefined;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string | undefined;
}

/** A legal document rendered at build time (legalMarkdown in vite.config.ts, src/legal/render.ts). */
declare module '*.md?legal' {
  const doc: import('./legal/render').RenderedLegal;
  export default doc;
}
