# termhub security and network guide

For IT and security teams asked to allow **termhub Cloud** (`app.termhub.dev`) with the termhub agent installed on employee machines. It explains how the system connects, what has to be allowed on the firewall, what the agent can do on a machine, and which controls protect it. The same facts apply to a self-hosted install, with your own host names in place of the Cloud ones.

Every statement here is backed by the code in this repository; the source files are listed in [Evidence](#evidence). Things termhub does **not** do yet are listed under [Known limitations](#known-limitations). They are not described as features.

Short version for the firewall ticket:

- The agent only makes **outbound** HTTPS/WebSocket connections on **TCP 443**. It opens **no listening port** on the machine and needs no SSH and no VPN.
- Allow `app.termhub.dev` and `termhub.dev` on 443, with WebSocket upgrades. Allow `registry.npmjs.org` to install and update the agent.
- **Explicit HTTP proxies are not supported by the agent yet.** Allow direct egress to the hosts above, or use a transparent proxy that passes WebSocket upgrades. If you inspect TLS, exempt the termhub hosts.

## 1. How it works

```
 Browser / phone                 termhub Cloud                    Employee machine
 ───────────────                 ─────────────                    ────────────────
 https://app.termhub.dev  ───►   web app, REST, WebSockets   ◄─── termhub agent (outbound WSS)
 termhub app (iOS/Android) ───►  termhub.dev/api/m, /ws/m    ◄─── hook script (outbound HTTPS POST)
                                                             ◄─── AI CLIs in termhub tabs (MCP over HTTPS)
```

- **Server.** It serves the web app, the REST API and the WebSocket endpoints. In the Cloud it sits behind Cloudflare, which terminates TLS. The server process itself speaks plain HTTP to that reverse proxy and never terminates TLS on its own.
- **Agent** (`@termhub/agent`, npm). It runs on each machine you want to reach, on **macOS or Linux** (Windows through WSL), with Node.js 20+ and tmux. On Linux, `npm i -g` also needs `make`, a C++ compiler and `python3`: node-pty publishes no Linux prebuild, so npm compiles it.
  - It dials out to the server over one persistent WebSocket, `wss://<server>/agent/ws`, and keeps it open.
  - Every terminal is a tmux session on the machine. Its bytes travel over that one socket, multiplexed as channels.
  - The agent runs as the **logged-in user**: a systemd user unit on Linux, a LaunchAgent on macOS. It needs no root, and no admin rights beyond installing tmux (and the build tools on Linux).
- **Web app.** A single-page app served by the server. Every API call and every WebSocket goes to the **same origin** it was loaded from, and the app's own code, styles and fonts are served from that origin too (no CDN, no font host). The one exception is **Google Analytics (GA4, through the Firebase SDK)**, and only after the user accepts cookies in the cookie banner; declining, or withdrawing consent later, keeps it off. When accepted, the browser loads `gtag.js` from `www.googletagmanager.com` and talks to `firebase.googleapis.com`, `firebaseinstallations.googleapis.com` and `*.google-analytics.com` (e.g. `www.google-analytics.com`, `region1.google-analytics.com`). It reports route changes with ids stripped and a few product events, never the user id, e-mail, machine names or terminal content. A build without the `VITE_FIREBASE_*` variables (a self-hosted install, by default) ships no analytics at all. Blocking these hosts does not break the app.
- **Mobile app.** It talks only to `termhub.dev` (`/api/m/v1/*` and `wss://termhub.dev/ws/m/chat`).
- **Monitor hooks** (optional, installed from the app). A small shell script that Claude Code, Codex or the Cursor CLI call on their events. It forwards the event with `curl` as an HTTPS POST to `termhub.dev/api/hooks/events`, so the app can show which tab is waiting for you.
- **Chat.** The termhub chat runs the `claude` CLI **on your own machine**, through the agent, with your own Claude login. That CLI calls back into termhub's MCP endpoint (`termhub.dev/mcp`) with a short-lived token scoped to the run.

### Connection behavior

| Connection | Direction | Keep-alive | Reconnect |
|---|---|---|---|
| Agent ⇄ server (`/agent/ws`) | machine → server | Both sides ping every 20 s; a missed pong drops the socket. The opening handshake times out after 15 s. | Exponential backoff from 1 s to 30 s with jitter. It stops only when the token is revoked (4401) or the protocol is too old. |
| Browser ⇄ server (`/ws/tabs`, `/ws/monitor`, `/ws/chat`, `/ws/sim`) | browser → server | Server pings every 30 s. | Terminal: exponential backoff up to 15 s, 8 attempts. Chat and monitor: every 5 s. |
| Phone ⇄ server (`/ws/m/chat`) | phone → server | Server pings every 30 s. | Backoff from 1 s to 30 s; reconnects immediately when the app returns to the foreground. |
| Hook events | machine → server | One POST per event, 5 s timeout, fire-and-forget. | None needed. |

A proxy or firewall that closes idle connections after **60 s or more** does not disturb these sockets, because each one carries a ping at least every 30 s. On a deploy, the server closes sockets with code 1012 and clients reconnect within seconds; open terminals keep their tmux session.

## 2. Ports and protocols

**On the employee machine**

- **Inbound: none.** The agent never listens on a network port. The only local sockets it opens are client connections to `127.0.0.1` on ports 8100–8199 and 9100–9199. It uses those only when you view an iOS Simulator (macOS), to reach the WebDriverAgent runner. The ranges are enforced both in the protocol schema and by the agent.
- **Outbound:** TCP 443, TLS. The agent's WebSocket, the hook script and the MCP calls all use it.

**Corporate proxies and TLS inspection**

- **Explicit proxy (`HTTPS_PROXY`):** **not supported by the agent's WebSocket today.** The agent connects directly, and the service definition does not carry proxy variables. Allow direct egress to the hosts in section 3. A transparent proxy works if it passes the WebSocket `Upgrade`. (The hook script uses `curl`, which honours `https_proxy` when it is set in the CLI's environment.)
- **TLS inspection (MITM):** the agent validates certificates with Node.js's built-in CA list, and the service does not pass an extra CA file. Inspection with a corporate root CA will make the handshake fail, so **exempt the termhub hosts from inspection**.
- **WebSocket:** make sure the proxy or firewall allows `Connection: Upgrade` / `Upgrade: websocket` to `app.termhub.dev` and `termhub.dev`.

## 3. Domains to allow

### Required

| Host | Port | Used by | Why |
|---|---|---|---|
| `app.termhub.dev` | 443 (HTTPS + WSS) | browsers; agent | Web app, REST API, browser WebSockets. The agent WebSocket `wss://app.termhub.dev/agent/ws` also lives here: the `connect` command the app shows uses the app's own address. |
| `termhub.dev` | 443 (HTTPS + WSS) | machines; phones | Hook events (`/api/hooks/events`), MCP endpoint for the chat and agent tabs (`/mcp`), mobile API and WebSocket (`/api/m/v1`, `/ws/m/chat`), and the website. |
| `registry.npmjs.org` | 443 | machines (install/update) | `npm i -g @termhub/agent`, and later updates from the app's update button or auto-update. |
| Cloudflare Access for termhub Cloud, `*.cloudflareaccess.com` | 443 | browsers | `app.termhub.dev` is protected by Cloudflare Access, which asks the user to sign in before the app loads. |
| `accounts.google.com` | 443 | browsers | Google sign-in, used by the Cloud's access check and by "Entrar com Google". |

### Optional, per feature

| Host | Used by | Needed for |
|---|---|---|
| Your OS package mirrors or Homebrew | machines | Installing tmux (and, on Linux, the build tools for node-pty) with the install command from Add machine (`brew` on macOS; `apt-get`, `dnf` or `pacman` on Linux). |
| The hosts your AI CLIs already use (e.g. Anthropic for Claude Code, OpenAI for Codex, Google for Gemini) | machines | The CLIs run in termhub tabs exactly as they would in any terminal. termhub adds no host of its own for them; follow each vendor's documentation. |
| `www.googletagmanager.com`, `firebase.googleapis.com`, `firebaseinstallations.googleapis.com`, `*.google-analytics.com` | browsers | Google Analytics in the web app, loaded only after the user accepts cookies. Blocking them only turns analytics off. |
| `github.com` | macOS machines | Only the first time you set up the iOS Simulator viewer (clones Appium's WebDriverAgent). |

The **server** also makes outbound calls, but only from termhub's side: npm (latest agent version), Google (OAuth), the ticket integrations you configure (GitHub, Linear, Jira), the usage endpoints of the AI providers, and Expo (mobile push). Your network does not need to allow those. They are listed for self-hosters in [Evidence](#evidence).

A self-hosted server behind an **explicit proxy** reaches them through it: the server image sets `NODE_USE_ENV_PROXY=1`, so `fetch`, `http` and `https` honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` once you set them in the server's environment (Node.js 22.21 or later; outside the image, set `NODE_USE_ENV_PROXY=1` yourself). List the compose services in `NO_PROXY` (`whisper,embed,mailpit,localhost,127.0.0.1`), or the server will send its own internal calls to the proxy. SMTP does not use those variables: set `SMTP_PROXY=http://proxy:3128` and the mail connection tunnels through the proxy with `CONNECT`.

## 4. What the agent installs and can do

**Installation**

- **The npm package** `@termhub/agent`, installed globally. It is published from GitHub Actions with **npm provenance**, so `npm view @termhub/agent` and `npm audit signatures` can tie each release to the public workflow that built it.
- **The config file** `~/.termhub/config.json`, created with mode `0600` in a `0700` directory. It holds the server URL and the machine's token.
- **The service** (`termhub-agent service install`):
  - Linux: a systemd **user** unit, `systemctl --user`. Keeping it running after logout requires `loginctl enable-linger`.
  - macOS: a **LaunchAgent** in `~/Library/LaunchAgents`.
  - Either way it runs as the user, not as root.
- **Monitor hooks** (optional, from the app):
  - the script `~/.termhub/bin/termhub-hook`;
  - its settings file `~/.termhub/hook.env` (mode `0600`);
  - entries merged into `~/.claude*/settings.json`, `~/.codex/config.toml` and `~/.cursor/hooks.json`.
  - Uninstalling from the app removes them.
- **Per-tab MCP config** for agents started from termhub: `~/.termhub/tabs/<tab>/`, deleted when the tab closes.

**What the server can ask the agent to do**

The server cannot send the agent an arbitrary shell command. It can only call a **closed list of named operations**, and every operation's parameters are validated with a schema on both ends. The list:

- open, list, resize, capture, scroll and close tmux sessions; type text or press keys from a fixed key list;
- list and create folders;
- detect installed tools; read hardware stats;
- paste a file into a tab;
- install or remove the monitor hooks;
- update the agent to a given version;
- read the local AI CLI login to show usage limits (see section 5);
- read `gh auth token`, only when you create a GitHub integration from the chat, and only after you confirm the card;
- scan the repository's `docs/` for the chat's memory;
- iOS Simulator actions (macOS).

A terminal tab is a real shell. Whoever can type into that tab — you in the browser, or the chat once you approve it — can run anything the user can run. The controls in section 5 decide **who** can type.

## 5. Threat model and controls

### Who can send input to a machine

1. **The signed-in user**, in their own tabs. Data is scoped by owner: another user's machines, projects and tabs answer 404.
2. **A personal API token** (MCP) the user created. Its scopes (`read`, `tasks`, `terminals`, `memory`) are intersected with the user's role, its expiry is optional, and it is limited to 120 calls per minute. It can be revoked at any time and stops working on the next call.
3. **The chat.** Every action that changes something becomes a **confirmation card** and nothing runs until a person approves it.
   - Approvals are single-use and expire after 24 h.
   - The following always need a card, and no permission grant can cover them:
     - running a command, deleting a card, pushing a ticket status;
     - creating an integration, changing a project's repository or machine links;
     - answering an agent's permission prompt.
   - Grants the user gives the chat are narrow and capped per hour. Some last 24 h ("this tab" or "this project"); a "Liberar sem prazo" grant for one project lasts until revoked. Any grant can be revoked from the web or the phone.
4. **Administrators.** Role-based permissions (`resource:action`) are checked centrally on every route. An admin role bypasses them, and admins can view other users' data.

### Authentication

- **Web login:**
  - by e-mail code: 6 digits, 10-minute expiry, 5 attempts per code, at most 3 codes per 10 min;
  - by password, hashed with **argon2id** (64 MiB, t=3);
  - with Google (PKCE, verified e-mail required);
  - and, in the Cloud, behind Cloudflare Access.
  - Repeated failures lock the e-mail and the IP progressively, up to 1 h.
  - There is no public sign-up: accounts are invited by an admin (Google sign-up of unknown accounts is off by default).
- **Sessions:**
  - a 256-bit random token; only its SHA-256 is stored;
  - an `HttpOnly`, `SameSite=Lax`, `Secure` cookie;
  - CSRF double-submit on every state-changing request;
  - an Origin check on WebSockets.
- **Machines:**
  - each machine gets a 256-bit token (`thb_ag_…`) that is shown once; the server stores only its SHA-256;
  - **rotating the token or deleting the machine drops the live connection immediately** (close 4401), and the agent stops retrying.
- **Phones:**
  - enrolment is approved by the owner on the web, and the same code is shown on both screens;
  - the phone holds a P-256 key in the platform keystore and signs every request with it (DPoP, ES256);
  - access tokens last 15 min, and renewing one needs the key plus a PIN-derived proof;
  - 3 wrong PINs lock the phone for 15 min, and 6 revoke it.

### Data in transit and at rest

- **In transit:** all client connections use TLS (HTTPS/WSS on 443), terminated by the Cloud's edge. Inside the hosting environment, the server talks to its database and helper services over a private network.
  - The database connection does not use TLS: in the compose setup the server and Postgres share a private network. If you self-host against a managed database across a network you do not control, add `sslmode=require` (or `verify-full` with the provider's CA) to `DATABASE_URL`.
  - The speech-to-text (`whisper`) and embeddings (`embed`) services each require a shared secret (`WHISPER_SECRET`, `EMBED_SECRET`) and refuse every request while it is empty, so reaching the private network is not enough to use them.
  - In production the server refuses to start with the compose fallback database password (`termhub`); set `POSTGRES_PASSWORD`.
- **At rest:**
  - integration tokens (GitHub, Jira, Linear) are encrypted with **AES-256-GCM**;
  - every credential termhub issues (session, API, agent, hook, mobile) is stored only as a hash;
  - other data is stored in the database as is (see [Known limitations](#known-limitations)).
- **Terminal content is never written to the server logs.** Logs carry metadata only (tab, machine, sizes), and cookies and authorization headers are redacted.
- **What the server keeps from your terminals:**
  - it does not store the terminal stream or scrollback;
  - it keeps each tab's latest status and the AI agent's last answer, which show on the home page and in the chat;
  - it keeps the chat conversation, and the commands or text the chat proposed on its cards;
  - voice dictation audio is transcribed in memory and never written to the server's disk.

### Credentials that belong to the machine

- **AI subscription logins** (Claude, ChatGPT/Codex, Gemini):
  - To show usage limits, the server asks the agent to read the CLI's login file on demand and uses it once to query the provider's usage endpoint.
  - The credential is **not stored** on the server; only the usage numbers are cached, in memory.
  - It does travel to the server over the encrypted agent connection for that query. If that is not acceptable, don't add AI accounts in termhub; everything else keeps working.
- **The chat's Claude login** never leaves the machine: the CLI runs there.
- **`gh auth token`** is read only when you confirm a "create GitHub integration" card. It is then stored encrypted, like any integration token.

### Revocation checklist

| To cut off… | Do this | Effect |
|---|---|---|
| A machine | Máquinas › the machine › rotate the token, or delete the machine | The live connection closes at once with 4401; the agent exits and its service stops retrying. |
| An API token | Settings › API tokens › revoke | The next call is refused. |
| A phone | Settings › Devices › revoke | Its WebSocket closes with 4401 and its tokens are refused. |
| A chat grant | the grant's "revoke" button (web or phone) | The next action asks again. |
| A user | Admin › Users › remove | The account and everything it owns are deleted at once: machines (their agents are disconnected), projects, integrations, sessions, tokens, devices, conversations and attachment files. |
| Your own account | Perfil (web) or Ajustes (app) › Excluir minha conta, or `termhub.dev/excluir-conta` | The account is deactivated at once (sessions end; API and device tokens are refused) and deleted for good after 30 days, with the same cascade as above. Signing in during the 30 days can cancel it. |
| On the machine itself | `termhub-agent service uninstall`, `termhub-agent disconnect`, `npm rm -g @termhub/agent` | Removes the service and the local config. Remove the monitor hooks first from the machine's page in the app ("Remover" on the hooks card). |

## 6. Checklist for IT

1. **Egress on TCP 443**, with WebSocket upgrades allowed, to:
   - `app.termhub.dev`
   - `termhub.dev`
   - `registry.npmjs.org`
   - Cloudflare Access (`*.cloudflareaccess.com`) and `accounts.google.com`, for browsers.
2. **No inbound rule** on the machines. No SSH, no VPN, no port forwarding.
3. **Exempt those hosts from TLS inspection.**
4. **No explicit proxy on the agent's path** (not supported yet): direct egress, or a transparent proxy.
5. **Machine prerequisites:** macOS or Linux, Node.js 20+, tmux, and a user account; on Linux, also `make`, a C++ compiler and `python3` (`build-essential python3` on apt, `"Development Tools" python3` on dnf, `base-devel python` on pacman). No root, apart from installing those packages with your package manager.
6. Optional: the hosts of the AI CLIs your users run, and your package mirrors for tmux and the build tools.
7. **Test from the machine:**
   ```bash
   npm i -g @termhub/agent                # reaches registry.npmjs.org
   termhub-agent connect --url https://app.termhub.dev --token <token from the app>
   termhub-agent doctor                   # "✓ Servidor" = token, TLS and WebSocket all got through
   termhub-agent status                   # "conectado ✓"
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://termhub.dev/api/hooks/events   # 401 = hooks host reachable
   ```
   `doctor` and `status` open a real WebSocket to `/agent/ws` with `probe: true`. The server validates the token and answers "probe-ok" without taking over the live session.

## Known limitations

These are open gaps, each tracked on the termhub board:

- The agent does not support an explicit HTTP(S) proxy or an extra CA bundle yet (TER-575).
- There is no SSO (SAML or generic OIDC), SCIM or multi-factor authentication for web users. The options are e-mail code, password, Google and Cloudflare Access (TER-581).
- There is no security audit trail for logins, role changes, admin "view as" or token management, and no audit export. Chat actions and phone events are recorded and visible in the app (TER-577).
- Sessions last 30 days with no idle timeout, and there is no "sign out everywhere" (TER-580).
- Chat messages, proposed commands, the agent's last answers and chat attachments are stored unencrypted in the database or on disk, with no retention limit; they are deleted with the conversation, project or user (TER-582).
- The app sends `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy`, but no HSTS or CSP of its own (TER-579).
- The agent token does not expire until it is rotated, and deleting a machine in the app does not uninstall the agent on the machine (TER-584).
- `termhub-agent doctor` checks the agent connection only, not the hooks and MCP host (TER-586).

## Evidence

Paths are relative to the repository root.

| Claim | Where |
|---|---|
| Agent dials `wss://<url>/agent/ws` with a bearer token; 20 s ping; 15 s handshake timeout; 1–30 s backoff; no proxy agent | `apps/agent/src/client.ts` |
| Agent has no listening socket; loopback-only TCP to WDA port ranges | `apps/agent/src/tcp.ts`, `packages/agent-protocol/src/rpc.ts` (`isWdaPort`), `packages/agent-protocol/src/messages.ts` (`tcpOpenParams`) |
| Closed list of agent operations | `apps/agent/src/rpc/index.ts`, `packages/agent-protocol/src/rpc.ts` |
| Config file `0600`/`0700` | `apps/agent/src/config.ts` |
| User-level service | `apps/agent/src/service/systemd.ts`, `apps/agent/src/service/launchd.ts` |
| `connect` command uses the app's origin | `apps/web/src/components/AgentEnrollment.tsx` |
| Probe used by `doctor`/`status` | `apps/agent/src/run.ts` (`checkServerConnection`), `apps/agent/src/doctor.ts` |
| Hook script posts with curl to `HOOKS_URL` | `packages/machine-ops/src/hooks.ts`, `apps/server/src/config.ts` |
| Hosts routed on `termhub.dev` (hooks, MCP, mobile) | `deploy/nginx/termhub.dev.conf.tmpl` |
| Server WebSocket endpoints, Origin check, pings, drain with 1012 | `apps/server/src/ws/router.ts`, `apps/server/src/agent/ws.ts`, `apps/server/src/terminal/ws.ts`, `apps/server/src/ws/drain.ts` |
| Web uses same-origin API and WebSockets only; no third-party scripts in `index.html` | `apps/web/src/lib/api.ts`, `apps/web/src/lib/terminal-connection.ts`, `apps/web/index.html` |
| Google Analytics (Firebase SDK) loads only after cookie consent, and not at all without `VITE_FIREBASE_*` | `apps/web/src/lib/analytics.ts`, `apps/web/src/lib/consent.ts` |
| Mobile base URL `termhub.dev`; DPoP ES256; hardware key; PIN proof | `apps/mobile/src/services/api/config.ts`, `apps/mobile/src/services/api/dpop.ts`, `apps/mobile/src/services/key/`, `apps/server/src/mobile/` |
| Agent token: 256 bits, SHA-256 stored; rotate/delete closes with 4401 | `apps/server/src/agent/token.ts`, `apps/server/src/routes/machines.ts` |
| Sessions, cookies, CSRF | `apps/server/src/auth/tokens.ts`, `apps/server/src/auth/routes.ts`, `apps/server/src/auth/middleware.ts` |
| argon2id parameters | `apps/server/src/auth/password.ts` |
| Login codes and lockout | `apps/server/src/auth/service.ts`, `apps/server/src/db/repositories/login-attempts.ts` |
| Roles and owner scope | `apps/server/src/auth/permissions.ts`, `apps/server/src/auth/scope.ts` |
| API token scopes, rate limit, revocation | `apps/server/src/auth/api-tokens.ts`, `apps/server/src/mcp/route.ts`, `apps/server/src/mcp/rate-limit.ts` |
| Chat confirmation cards and grants | `apps/server/src/chat/gate.ts`, `apps/server/src/chat/gate-runtime.ts` |
| AES-256-GCM for integration secrets | `apps/server/src/lib/crypto.ts`, `apps/server/src/db/repositories/integrations.ts` |
| Terminal content not logged; header redaction; security headers | `apps/server/src/terminal/ws.ts`, `apps/server/src/app.ts` |
| AI credential read on demand, not stored | `packages/machine-ops/src/ai-credentials.ts`, `apps/agent/src/rpc/ai.ts`, `apps/server/src/ai/` |
| `gh auth token` read | `apps/agent/src/rpc/secret.ts`, `apps/server/src/control/integrations.ts` |
| Voice audio not written to disk | `apps/server/src/terminal/transcription.ts` |
| whisper and embed refuse requests without their shared secret; default database password refused in production; outbound proxy | `docker/whisper/auth.py`, `docker/embed/api.py`, `apps/server/src/config.ts`, `Dockerfile` (`NODE_USE_ENV_PROXY`), `apps/server/src/email/mailer.ts` (`SMTP_PROXY`) |
| npm provenance | `.github/workflows/publish-agent.yml` |
| Server outbound calls (self-hosting): `registry.npmjs.org`, `oauth2.googleapis.com`, `www.googleapis.com`, `api.github.com`, `api.linear.app`, Jira base URL, `api.anthropic.com`, `chatgpt.com`, `cloudcode-pa.googleapis.com`, `exp.host`, SMTP, Cloudflare API | `apps/server/src/agent/latest-version.ts`, `apps/server/src/auth/google.ts`, `apps/server/src/integrations/`, `apps/server/src/ai/`, `apps/server/src/mobile/push.ts`, `apps/server/src/email/mailer.ts`, `apps/server/src/cloudflare/access.ts` |
