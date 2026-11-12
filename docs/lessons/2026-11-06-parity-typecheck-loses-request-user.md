---
symptom: "src/features/flags.ts(61,18): error TS2339: Property 'user' does not exist on type 'FastifyRequest<…>'"
tags: [typecheck, typescript, fastify, server]
evidence: fixed
card: TER-1164
agent: claude
date: 2026-11-06
---
## Cause

`npm run typecheck -w @termhub/server` runs two compiles. The first (`tsconfig.json`) loads every file in
`src`, including `auth/middleware.ts`, whose `declare module 'fastify'` adds `request.user`. The second
(`tsconfig.parity.json`) includes only `src/mobile/events-parity.test.ts` and whatever it imports. Once a
new import chain from that test reached `features/flags.ts` (chat/gate-runtime → chat/blocks → features/flags),
`flags.ts` was compiled without `middleware.ts`, so the augmentation was missing and `request.user` did not
exist. The first compile passes, so the error looks impossible until you see it comes from the second.

## Fix

Do not rely on a module augmentation from a file the importer does not itself import. In
`features/flags.ts`, `requestUserId` reads the user through a local type
(`(request as { user?: { id: string } | null }).user`) instead of `request.user`. Importing
`auth/middleware.ts` would also work, but it pulls the config (and its env check) into the graph.

## How to check

`cd apps/server && npx tsc -p tsconfig.parity.json` prints no error, and `npm run typecheck -w @termhub/server`
exits 0.
