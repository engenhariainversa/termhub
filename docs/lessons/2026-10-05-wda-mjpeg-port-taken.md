---
symptom: "iOS simulator tab stuck on \"Reconectando ao simulador…\" with \"fetch failed\" toasts; server log loops \"túnel/stream caiu, tentando recuperar: MJPEG respondeu 404\""
tags: [simulator, wda, mjpeg, ports, macos]
evidence: observed
card: TER-983
pr: https://github.com/engenhariainversa/termhub/pull/387
agent: claude
date: 2026-10-05
---
## Cause

The WDA ports come from a hash of the UDID (`8100/9100 + hash % 100`). On the Mac, another program
(root or another user, so the user's `lsof` and `netstat` do not show it) already listened on the
MJPEG port 9180. WDA logged `Cannot init screenshots broadcaster service on port 9180 ... Address
already in use` but `/status` still answered `ready: true`, so the server kept reconnecting to a
foreign server that answered 404. "fetch failed" was undici's error for commands sent through tunnels
the loop had just closed.

## Fix

The server probes the candidate pairs through the tunnel before starting the runner, checks the MJPEG
after WDA is ready, and moves the runner to the next free pair (`ports.ts`, `port-probe.ts`,
`session-manager.ts`). A stream that ends before its first frame 3 times in a row stops the session
with "O vídeo do simulador não responde (…)".

## How to check

On the Mac: `tmux capture-pane -p -J -t termhub-wda-<udid8> -S - | grep -i "broadcaster"` shows the
bind error; `python3 -c "import socket; socket.socket().bind(('127.0.0.1', 9180))"` fails with errno 48
when the port is taken even if `lsof` lists nothing. After the fix, the server log shows
"porta MJPEG do WDA ocupada por outro programa; trocando de portas" and the tab connects.
