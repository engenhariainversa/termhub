---
symptom: "FAIL src/rpc.test.ts > rpc catalog > lists the v1 methods — AssertionError: expected [ 'agent.uninstall', …(50) ] to deeply equal [ 'agent.uninstall', …(49) ]"
tags: [ci, agent-protocol, rpc]
evidence: fixed
card: TER-1148
pr: https://github.com/engenhariainversa/termhub/pull/553
agent: claude
date: 2026-11-11
---
## Cause

`packages/agent-protocol/src/rpc.test.ts` pins the full, sorted list of RPC method names. A PR that adds a
method to `packages/agent-protocol/src/rpc.ts` (here `claude.trustFolder`) without adding it to that list
fails the "Testes protocolo do agente" step, which runs late in the `check` job — after the server, web and
mobile suites have all passed, so the run looks green until the very end. The server and agent tests of the
PR do not catch it.

## Fix

Add the new method name to the expected list in `rpc.test.ts`, in alphabetical order.

## How to check

`npm test -w @termhub/agent-protocol` (in `node:22`, see CLAUDE.md) passes; on CI, the step
"Testes protocolo do agente" is green.
