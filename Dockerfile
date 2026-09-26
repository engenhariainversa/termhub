# syntax=docker/dockerfile:1
# ── Produção: build do web + server, imagem final enxuta com tmux/ssh ──
FROM node:22-alpine AS base
WORKDIR /app

# Dependências (node-pty e argon2 compilam nativo → toolchain no build)
FROM base AS deps
RUN apk add --no-cache python3 make g++ openssl
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY apps/agent/package.json apps/agent/
COPY apps/concierge/package.json apps/concierge/
COPY apps/mobile/package.json apps/mobile/
COPY packages/agent-protocol/package.json packages/agent-protocol/
COPY packages/machine-ops/package.json packages/machine-ops/
COPY packages/mobile-api/package.json packages/mobile-api/
COPY scripts/postinstall.mjs scripts/
# Only the workspaces the server image needs: @termhub/mobile (Expo / React Native) shares the
# lockfile but never runs here, and its dependency tree would inflate node_modules for nothing.
# Add a new workspace to this list only if the server or web build imports it.
RUN npm ci --include-workspace-root \
    -w @termhub/server -w @termhub/web -w @termhub/landing -w @termhub/agent -w @termhub/concierge \
    -w @termhub/agent-protocol -w @termhub/machine-ops -w @termhub/claude-cli -w @termhub/mobile-api

# Build
FROM deps AS build
COPY . .
# Firebase Analytics config for the web app (docker compose build args). Vite bakes the
# VITE_* values into the static bundle, so the image must be rebuilt whenever they change.
# Empty = app without analytics.
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_STORAGE_BUCKET=
ARG VITE_FIREBASE_MESSAGING_SENDER_ID=
ARG VITE_FIREBASE_APP_ID=
ARG VITE_FIREBASE_MEASUREMENT_ID=
# Short commit this image is built from: the chat header shows it, so a screen can be told apart
# from a cached one without guessing.
ARG VITE_BUILD_SHA=
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_FIREBASE_MEASUREMENT_ID=$VITE_FIREBASE_MEASUREMENT_ID \
    VITE_BUILD_SHA=$VITE_BUILD_SHA
RUN npm run prisma:generate && npm run build
# The public city, built on its own with base /city/ so it never shares an asset path with the app bundle above.
RUN npm run build:city -w @termhub/web
# Só dependências de produção na imagem final. The same workspace list as the deps stage: a bare
# `npm prune` re-reads the whole lockfile and would bring @termhub/mobile's tree back in.
RUN npm prune --omit=dev --include-workspace-root \
    -w @termhub/server -w @termhub/web -w @termhub/landing -w @termhub/agent -w @termhub/concierge \
    -w @termhub/agent-protocol -w @termhub/machine-ops -w @termhub/claude-cli -w @termhub/mobile-api

# Runtime
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# rsvg-convert + font-inter: the public city's link preview card (apps/server/src/public/card.ts)
# rasterises with the same librsvg tool apps/landing/og/build.sh uses, as a runtime subprocess.
# Package names are Alpine's (apk), not Debian's librsvg2-bin — this image is node:22-alpine.
# /data/chat-files: the chat-files volume is initialised from this directory, owner included.
RUN apk add --no-cache tmux openssh-client bash tini rsvg-convert font-inter \
 && addgroup -S app && adduser -S app -G app -h /home/app -s /bin/bash \
 && mkdir -p /home/app/.ssh && chown app:app /home/app/.ssh && chmod 700 /home/app/.ssh \
 && mkdir -p /data/chat-files && chown app:app /data/chat-files
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./
COPY --from=build --chown=app:app /app/apps/server/package.json ./apps/server/
COPY --from=build --chown=app:app /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=app:app /app/apps/server/prisma ./apps/server/prisma
COPY --from=build --chown=app:app /app/apps/server/prisma.config.ts ./apps/server/
COPY --from=build --chown=app:app /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=app:app /app/apps/web/dist-city ./apps/web/dist-city
# @termhub/server imports these at runtime through the node_modules/@termhub/* workspace symlinks
# (copied above with node_modules), which point at ../../packages/<name> — the targets must exist
# at that same relative path in the runner stage.
COPY --from=build --chown=app:app /app/packages/agent-protocol/package.json ./packages/agent-protocol/
COPY --from=build --chown=app:app /app/packages/agent-protocol/dist ./packages/agent-protocol/dist
COPY --from=build --chown=app:app /app/packages/machine-ops/package.json ./packages/machine-ops/
COPY --from=build --chown=app:app /app/packages/machine-ops/dist ./packages/machine-ops/dist
COPY --from=build --chown=app:app /app/packages/mobile-api/package.json ./packages/mobile-api/
COPY --from=build --chown=app:app /app/packages/mobile-api/dist ./packages/mobile-api/dist
COPY --chown=app:app docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# entrypoint roda "prisma migrate deploy" antes de subir o servidor
CMD ["/app/docker/entrypoint.sh"]
