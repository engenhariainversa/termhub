---
symptom: "A role with only terminals:read can type into the terminal (and gating input on terminals:write would lock AUTHENTICATED/MANAGER out)"
tags: [auth, permissions, websocket, migration]
evidence: fixed
card: TER-576
pr: https://github.com/engenhariainversa/termhub/pull/320
agent: claude
date: 2026-10-05
---
## Cause

The upgrade router (`apps/server/src/ws/router.ts`) has one gate for every cookie WebSocket,
`terminals:read`, and `/ws/tabs` and `/ws/sim` forwarded every client message without checking more.
The HTTP typing routes (`/tabs/:id/input`, `/paste-file`) were on `terminals:update`. The trap in the
fix: `terminals:write` existed only for the MCP write tools, and no migration ever granted it to
AUTHENTICATED or MANAGER (only BETA, in `20260925150000_beta_terminals_write`). Gating input on it
alone would have silently taken the keyboard from every non-admin user on deploy.

## Fix

The router passes `canWrite` (`terminals:write`) to each route; the terminal socket drops input,
resize and scroll without it (`ready.readonly`), the simulator socket drops actions (`{type:'readonly'}`),
the HTTP routes take `write`. A data migration grants `terminals:write` to every non-admin role holding
`terminals:update`. Whenever a route moves to a grant that default roles may lack, backfill it in the
same PR.

## How to check

`npx vitest run --root apps/server src/ws src/terminal src/simulator src/routes/tabs.test.ts src/mcp/route.test.ts`;
in prod, an AUTHENTICATED user still types, and the role matrix (Configurações → Roles) shows `write` on Terminais for it.
