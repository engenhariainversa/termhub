# iOS simulator: WDA ports already in use (TER-983)

## Problem

On the Mac mini (hulk), the "CCRoad M6 QA" simulator tab never connects. It stays on
"Reconectando ao simulador…", and toasts show "fetch failed".

Evidence collected on 2026-10-05:

- termhub derives the WDA ports from the UDID (`ports.ts`: `8100/9100 + fnv1a(udid) % 100`) without
  checking that they are free. For this UDID: 8180 (WDA) and 9180 (MJPEG).
- Another process (another user or root, invisible to the user's `lsof`) already listens on
  `127.0.0.1:9180` and answers `HTTP/1.0 404`.
- The runner logs `bind(8, ::.9180) ... [48: Address already in use]` and
  `Cannot init screenshots broadcaster service on port 9180`, yet `/status` answers `ready: true`.
- The server opens the MJPEG stream, receives the foreign 404 (`MJPEG respondeu 404` in the server log),
  and calls `recover()`. Reconnecting "succeeds" because `/status` is fine, so the stream is reopened
  and fails again. `RECOVER_ATTEMPTS` only counts failed reconnects, so the cycle never ends
  (~4 cycles/s).
- "fetch failed" is undici's raw error: commands from the viewer (quality, screen refresh) hit a local
  tunnel port that the loop had just closed, and `ws.ts` toasts the message as-is.

Xcode 26.4, iOS 26.4, WDA 16.12.8 and the agent were all healthy.

## Design

### Port candidates (`ports.ts`)

`wdaPortCandidates(udid, count = 10)` returns pairs
`{ wdaPort: 8100 + (h + k) % 100, mjpegPort: 9100 + (h + k) % 100 }` for `k = 0..count-1`. Candidate 0
equals today's `wdaPorts(udid)`, so runners started by an older server are still found and nothing
changes when the ports are free.

### Port probe (`port-probe.ts`)

`probePorts(tunnel)` makes one HTTP request on each local tunnel port and classifies each one:

| WDA port (`GET /status`) | MJPEG port (`GET /`) |
|---|---|
| `free`: the connection closed or was refused with no response | `free`: same |
| `wda`: 200 with a JSON body whose `value.ready` is a boolean | `mjpeg`: 200 with `Content-Type: multipart/x-mixed-replace` |
| `taken`: any other response, or 3 s without a response on an open connection | `taken`: same |

This works for every machine type: a local machine probes the real port, an SSH tunnel closes the
local socket when the remote `connect` fails, and an agent tunnel does the same on `ECONNREFUSED`.
The MJPEG probe destroys the request as soon as the headers arrive (WDA streams forever).

The backend gets `probePorts(machine, ports)`. It opens a tunnel, probes, and closes the tunnel.

### Start (`SimulatorSessionManager.start`)

1. Boot (unchanged).
2. Pick the ports:
   - **Runner already running**: probe the candidates in order (starting with the remembered pair, if
     any). The first pair with `wda` + `mjpeg` is the runner's. If none matches, stop the runner, show
     "Reiniciando o WebDriverAgent em outras portas…", and continue as below.
   - **No runner**: the first pair where both ports are `free`. If none is free, fail with
     "Nenhuma porta livre para o WebDriverAgent no Mac (8100–8199 / 9100–9199)".
3. Start the runner and wait for `/status` (unchanged).
4. **Check the MJPEG**: probe the pair. A `free` MJPEG port is ambiguous right after `/status` (WDA may
   not have bound it yet), so wait one poll interval and probe once more. If the MJPEG port is not `mjpeg`, stop the runner, exclude the
   pair, pick the next free one and go back to step 3. After 2 relocations, fail with
   "A porta <mjpeg> do Mac está em uso por outro programa; o vídeo do simulador não consegue subir"
   and the runner's tail.
5. Remember the pair in memory, per machine + UDID, for the next session.

### Recovery (`recover`)

Each session counts MJPEG streams that end before delivering a frame (`streamStrikes`). The first
frame resets the count. When a stream ends with no frame and the count reaches `RECOVER_ATTEMPTS`
(3), the session stops reconnecting. The viewer gets
"O vídeo do simulador não responde (<cause>)", where `<cause>` is the reader's pt-BR message
(e.g. "MJPEG respondeu 404"), and the session is disposed as an exhausted recovery is today.

### Toasts (`ws.ts`)

A command that fails with undici's `TypeError: fetch failed` toasts
"Simulador reconectando; tente de novo em instantes." instead of the raw text.

## Out of scope

- No agent or `machine-ops` change: no new RPC, no npm release.
- Identifying who holds the port: the message names the port; the person decides.
- Two devices whose candidate lists overlap: on a fresh start the other device's runner counts as
  taken, so the second device moves on to the next pair. When locating a runner that is already
  running and the remembered pair is unknown (e.g. after a deploy), a runner of another device on an
  earlier candidate would be adopted, since WDA's `/status` does not carry the UDID. This needs two
  booted simulators with overlapping lists *and* a collision; today's scheme already shares this
  limit when two UDIDs hash to the same pair.

## Testing

- `ports.test.ts`: candidate 0 equals `wdaPorts`, wrap-around at 100, 10 distinct pairs.
- `port-probe.test.ts`: real `net`/`http` servers for each class (refused, immediate close, foreign
  404, WDA JSON, multipart, silent listener).
- `session-manager.test.ts` (fake backend): runner found on a shifted pair; taken pair skipped on a
  fresh start; MJPEG check fails → runner stopped and restarted on the next pair; no free pair →
  clear error; a stream that keeps ending without frames stops after 3 strikes with the clear message.
- `ws.test.ts`: `fetch failed` becomes the pt-BR toast.

## Impact on other users

Everyone using the iOS simulator tab gets this by default. With free ports nothing changes: same pair
as before, plus a probe that takes under a second. When a port is taken, the tab now moves to free
ports on its own or shows a clear error instead of reconnecting forever. Machines need no agent
update.
