# syntax=docker/dockerfile:1
# ── Landing (termhub.dev): static build served by nginx ──
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY scripts/postinstall.mjs scripts/
# --ignore-scripts: the other workspaces' native modules (node-pty, argon2) are not needed here
RUN npm ci --ignore-scripts
COPY apps/landing apps/landing
# Firebase Analytics config (docker compose build args). Declared after the COPY so the
# install/copy layers stay cached; Vite reads them from the env and bakes them into the
# bundle. All empty = the landing ships without analytics.
ARG VITE_FIREBASE_API_KEY=
ARG VITE_FIREBASE_AUTH_DOMAIN=
ARG VITE_FIREBASE_PROJECT_ID=
ARG VITE_FIREBASE_STORAGE_BUCKET=
ARG VITE_FIREBASE_MESSAGING_SENDER_ID=
ARG VITE_FIREBASE_APP_ID=
ARG VITE_FIREBASE_MEASUREMENT_ID=
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_FIREBASE_MEASUREMENT_ID=$VITE_FIREBASE_MEASUREMENT_ID
RUN npm run build -w @termhub/landing

FROM nginx:1.27-alpine AS runner
COPY apps/landing/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/landing/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/apps/landing/dist /usr/share/nginx/html
EXPOSE 80
