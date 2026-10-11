---
symptom: "Terminals on the web stay on a black screen with \"Conectando…\" for tens of seconds after a deploy, a page load or a project switch; the tmux sessions are alive"
tags: [web, websocket, chrome, terminal, deploy, cloudflare]
evidence: fixed
card: TER-902
agent: claude
date: 2026-10-04
---
## Cause

Not the server and not the agent. Every terminal tab has its own WebSocket, and the page opens all of a
project's terminals at once: on load, on a project switch, and again after every deploy (1012). Chromium
runs **one WebSocket handshake per host at a time** and **delays each new socket more the more are already
pending** (about 1–5 s each once ~16 are pending). Measured with a headless Chromium against a server that
answers the upgrade after 100–150 ms: 10 sockets connect one after the other, and with 16–20 sockets the
later ones get an extra ~2 s each.

In production (2026-10-04) a project with 16 terminals plus the chat and monitor sockets: the server log
shows `terminal conectado` one tab at a time, 1–20 s apart, 35–65 s for the whole project, while HTTP
requests answered in milliseconds and nginx shows each tab's socket exactly once (no failures, no retries).
The tab on screen could sit at the back of that queue. Mounted tabs show "Conectando…", reconnecting ones
"Reconectando…". The agent on that machine was 0.13.0, so the TER-850 PTY changes (0.14.x) were not involved.

## Fix

`apps/web/src/lib/connect-gate.ts`: a per-page gate that lets two terminal handshakes run at a time, the
visible terminal (`active`) first. `TerminalConnection` waits for a slot, releases it when the handshake
settles (open, close or a 10 s handshake timeout, which then retries), and gives it up when closed while
waiting. Keeping few handshakes pending also avoids Chromium's throttling delay.

## How to check

`npx vitest run src/lib/connect-gate.test.ts src/lib/terminal-connection.test.ts` in `apps/web`. In
production, after a deploy or a project switch, `docker logs termhub-app-<color> | grep 'terminal conectado'`
shows a project's tabs connecting within a few seconds, the one on screen first.
