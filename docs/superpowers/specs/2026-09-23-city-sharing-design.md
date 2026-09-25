# City sharing — story/post images, a live video, and a short link — design

Date: 2026-09-23. Status: **approved design, not implemented.** Builds on the public city
(`2026-09-22-public-city-design.md`), the "Minha cidade" settings tab and the beta card on the city page.

## 1. Goal

Make a public city easy to spread on social networks:

- Anyone on a public city page — the owner or a visitor — can download or share a **story image
  (9:16)**, a **post image (16:9)** and a **10-second story video (9:16) with sound**, all showing the
  city as it is right now.
- Every city gets a **short link** (`77a.it/<nickname>`) created through TypeToAccess, a partner of
  termhub. The owner sees it in "Minha cidade" and may replace it with a short link of their own.

Success: a visitor lands on a city, taps "Compartilhar", and in under 15 seconds has an MP4 or a PNG
in Instagram's story composer, with a readable short link and the beta invitation on it.

Out of scope: short links for a building or a room (only the city gets one), GIF output, server-side
rendering of media, analytics of shares.

## 2. Media: one compositor, three outputs

Everything is produced in the visitor's browser, inside the public city bundle
(`apps/web/src/city/**`). No server work, no server cost.

### 2.1 Capturing the scene

The scene is a PixiJS WebGL canvas (`OfficeScene`, `apps/web/src/office/scene/OfficeScene.ts`).
Reading a WebGL canvas outside the render pass returns a blank image, so the scene gains one method:

- `onFrame(cb: (canvas: HTMLCanvasElement) => void): () => void` — calls `cb` right after each
  render with the canvas that was just drawn; returns an unsubscribe. Implemented with the renderer's
  post-render hook. PixiJS stays imported only under `office/scene/`.
- `lockCamera(locked: boolean)` — while recording, the camera ignores drags, wheel and re-framing on
  resize, so the video does not shake. The current framing (city, building or room the visitor is
  looking at) is what gets recorded.

### 2.2 The compositor

`apps/web/src/city/share/compose.ts` — pure layout plus a draw function.

- `layoutFor(format, info)` → rectangles and strings, no DOM. `format` is `'story'` (1080×1920) or
  `'post'` (1920×1080). `info` = `{ ownerName, working, waiting, shortLink }`.
- `drawFrame(ctx, layout, sceneCanvas)` paints one frame on a 2D canvas.

Story (1080×1920), top to bottom:
1. Header: termhub mark, "Cidade de {nome}", and a live line — "3 agentes trabalhando agora ·
   1 esperando você" (counts from the same model the page renders; the second clause only when > 0).
2. Scene: ~70% of the height, the scene canvas scaled to cover and centred on what the camera shows.
3. Footer: the short link in large type (legible on a phone), and "Participe do beta grátis".

Post (1920×1080): the same three bands side by side — scene on the left (~62% of the width), a text
column on the right with header, link and invitation.

Colours and type: the city page's tokens (dark background, `line`, `fg`, `fg-muted`) and the brand's
accent gradient (`#5b63d3 → #7c87f7`) for the link and the invitation. Pixel-art scaling uses
`imageSmoothingEnabled = false`.

### 2.3 Images

A still is one `drawFrame` on an offscreen canvas at the output size, then `canvas.toBlob('image/png')`.
Files: `termhub-cidade-<nickname>-story.png`, `termhub-cidade-<nickname>-post.png`.

### 2.4 Video (real-time recording)

`apps/web/src/city/share/record.ts`.

- A 1080×1920 canvas redrawn with `drawFrame` on every scene frame; `canvas.captureStream(30)` gives
  the video track.
- The audio track comes from the city soundscape (§2.5) via a `MediaStreamAudioDestinationNode`.
- `MediaRecorder` over the combined stream for 10 s. Format choice, first supported wins:
  `video/mp4;codecs=avc1.42E01E,mp4a.40.2` → `video/mp4` → `video/webm;codecs=vp9,opus` →
  `video/webm`. `pickMimeType(isTypeSupported)` is a pure function.
- File: `termhub-cidade-<nickname>-story.mp4` (or `.webm`).
- Cancelled when the page is hidden (`visibilitychange`): browsers pause animation frames in a
  hidden tab and the video would freeze. The panel says so and offers to record again.

### 2.5 The city soundscape

`apps/web/src/city/share/sound.ts`, with two Pixabay recordings in `apps/web/src/city/share/audio/`
(Pixabay Content License, no attribution required). The levels and a three-band equaliser are the
visitor's, set in the page's "Som" panel and kept in the browser; the videos record with them.

- An office ambience for the whole clip, at 70% by default.
- A recorded keyboard, at 40% by default, layered once per robot whose activity is coding/typing (up to three
  layers, offset in the loop), silent when none is.
- A soft synthesised "ding" each time a robot raises its hand (enters a waiting-for-you state) during the clip.

`soundEvents(prev, next)` is a pure function from two model snapshots to the events to play. Sound
goes only into the recording; the page itself never plays audio.

### 2.6 The share panel

A "Compartilhar" button in the city page's top bar (visible to every visitor) opens a panel with:

- **Story (imagem)**, **Post (imagem)**, **Vídeo para story (10 s, com som)**, **Copiar link**.
- Recording state: "Gravando… 7 s", a progress bar, "Cancelar". The scene stays live.
- When done: a preview, then **Compartilhar** / **Baixar** / **Gravar de novo**.

Delivery: on devices where `navigator.canShare({ files })` accepts the file, "Compartilhar" opens
the native share sheet (Instagram appears there); otherwise, and always on desktop, "Baixar" saves
the file. If the share sheet rejects the file, fall back to download.

States and errors:
- No `MediaRecorder` or no `captureStream`: the video option is disabled with "Seu navegador não
  grava vídeo; as imagens continuam disponíveis."
- Only WebM available: record, then warn "O Instagram pode não aceitar WebM. No celular, use o
  Safari ou o Chrome."
- The scene failed to draw: the "Compartilhar" button is hidden; "Copiar link" stays in the page.
- City empty or still loading: the button is disabled until the scene has a model.

"Minha cidade" gets an "Abrir minha cidade para compartilhar" link to the public page rather than
its own media buttons — media is produced where the scene is drawn.

## 3. Short link through TypeToAccess

### 3.1 The partner API

`POST https://api.typetoaccess.it/v1/links`, `Authorization: Bearer <key>`, body
`{ "url": "<city url>", "slug": "<nickname>" }` → `201` with `{ id, slug, url, shortUrl,
clickCount, createdAt }`. `409` when the slug is taken; `429` above 120 requests/min; each link
counts against the account's quota. There is no update or delete endpoint.

Configuration: optional `TYPETOACCESS_API_KEY` in the server config. Without it the whole feature is
off — no calls, no UI — and the long link is used everywhere (self-hosted instances).

### 3.2 Data

Two nullable columns on `users` (additive migration):

- `city_short_url_partner` — the link termhub created through TypeToAccess.
- `city_short_url_custom` — a link the person pasted to replace it.

The effective short link is `custom ?? partner ?? null`. Keeping the partner link when a custom one
is set lets the person switch back without a new API call (TypeToAccess cannot edit or delete links).

### 3.3 Creating the partner link

`apps/server/src/public/short-link.ts`:

- Triggered when a nickname is claimed (`PATCH /me/nickname`, first time), after the write, without
  delaying the response.
- Tries `slug = nickname`; on `409`, retries once with no slug (random). Timeout 5 s.
- On any failure (network, 5xx, 429, quota), stores nothing and logs metadata only. A lazy retry
  happens the next time the person opens "Minha cidade" (`GET /me/city-link` sees a claimed nickname,
  the key configured and no short link, and tries once, rate-limited to one attempt per user per
  10 minutes in memory).
- Because the nickname is locked once set, the city URL never changes and the link never goes stale.

### 3.4 Replacing it with a custom link

`PUT /me/city-link` with `{ short_url }`:

- Must be `https://77a.it/<slug>`.
- The server requests it with redirects not followed and accepts it only if the `Location` is this
  person's city URL (`<public city base>/@<nickname>`, trailing slash and case of the host
  tolerated). Otherwise `400 SHORT_LINK_MISMATCH` with the URL it actually points to.
- Stored in `city_short_url_custom`.

`DELETE /me/city-link/custom` clears the custom link, so the partner link is effective again; if
there is no partner link yet, one is created as in §3.3.

### 3.5 Where the short link is used

The effective short link (or, when there is none, the long URL) is used by:
- "Minha cidade": "**Link curto: 77a.it/pedro** [Copiar]", note "Criado pelo TypeToAccess, parceiro do
  termhub" for the partner link, "Usar meu próprio link curto" (link to typetoaccess.it + a field to
  paste it, with the server's mismatch message), and "Voltar ao link da parceria" for a custom one.
- The office share button (city depth only; building/room keep the long link).
- The public city: the snapshot's `PublicCity` gains `short_url: string | null` — public by nature,
  named explicitly in `toPublicCity` — used by "Copiar link" and by the media footers.

## 4. Privacy and the bundle rule

- Media contain only what the page already shows publicly. The compositor reads the page's model,
  never anything else.
- The API key lives only in the server environment; the browser never talks to TypeToAccess.
- The share code lives under `apps/web/src/city/share/` and imports nothing from the private app; the
  bundle guard test keeps proving it.

## 5. Testing

- `layoutFor`: story and post rectangles stay inside the canvas; long names are ellipsised; the
  waiting clause appears only when > 0.
- `pickMimeType`: order and fallbacks.
- `soundEvents`: clicks follow coding robots; a ding per newly raised hand; nothing when unchanged.
- Share panel: options, recording progress and cancel, cancel on hidden page, share-sheet vs download,
  WebM warning, disabled video without MediaRecorder.
- `OfficeScene.onFrame` / `lockCamera`: unit-tested where the scene's existing tests reach; the rest
  covered by the panel tests with a fake scene.
- Short link: partner creation with the nickname slug, 409 → random, failure stores nothing, lazy
  retry and its rate limit, feature off without the key; custom link accepted only on the right
  redirect; restore to partner; `toPublicCity` emits `short_url`.
- Bundle guard under CI.

## 6. Delivery

Two PRs, in this order: (1) short link (server + Minha cidade + `short_url` in the public payload);
(2) media (compositor, images, video, sound, share panel), whose footers use the short link.
