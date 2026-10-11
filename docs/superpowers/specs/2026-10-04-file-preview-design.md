# File preview: Markdown written by agents, read without leaving termhub — design

TER-941, asked for by the maintainer on 2026-10-04. Agent, server, web and mobile app; no migration.

## 1. Problem

Agents write Markdown files all the time: reports (`~/relatorio-termhub-10-dias.md`), specs, plans,
lessons. Their answers name those files, but reading one means opening it in a terminal or on GitHub.

What exists today:

- `docs.scan` / `docs.read` (agent RPCs) read only `docs/superpowers/{specs,plans}` and `docs/lessons`
  of a project, for the memory index. They are not a general reader.
- `transcript.read` (TER-759, agent 0.15.0) set the pattern this design follows: one RPC, gated by a
  capability, with "Atualize o agente" when the machine's agent is older.
- The web renders untrusted model Markdown in exactly one place (`apps/web/src/lib/markdown.ts`,
  `markdownOnly`: an allowlist of Markdown's own tags, no images). The app renders it with
  `react-native-markdown-display` (`message-bubble.tsx`), which both the concierge chat and Sessões use.
- The web has no tab-chat view; a tab's answer reaches the web only through the concierge chat.

## 2. Decisions

From the maintainer (2026-10-04, in the chat): **on the web the preview opens as a tab in the project's
tab bar, like the terminal tabs of TER-904 (preview tab and pin), not in a side panel.**

Taken while writing this document:

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| D1 | Reader | A new agent RPC, `file.read`, in Node (no shell), behind the capability `file_read`, agent 0.16.0. Older agent: 409 `AGENT_OUTDATED`, "Atualize o agente desta máquina…". | Same gate as `transcript` (an old agent drops unknown RPCs, which reads as a timeout). Node's `realpath`/`open` make the link checks exact; a shell script would not. |
| D2 | Machines | Agent machines only; `ssh`/`local` answer `UNSUPPORTED_MACHINE`. | Same as tab chat D5. |
| D3 | Allowed folders | The project's folder on that machine (`project_machines.cwd`, sent by the server), the agent user's home, the temp dirs (`os.tmpdir()`, `/tmp`), and folders the machine's owner lists in `~/.termhub/file-read-roots` (one per line). `/` is never a folder. | What the card asked for. The extra list lives on the machine, so only its owner can widen it; the server cannot. |
| D4 | Dot folders | Any segment starting with `.` below the folder that holds the file is refused (`~/.ssh`, `~/.aws`, `.git`, `.env.md`). A project that itself lives in a dot folder still works, because its own folder is one of the folders. | Home as a folder is only safe if its hidden config is not. The cost: `~/.claude/plans` is not readable (follow-up if wanted). |
| D5 | Links | Checked twice: the path as written, and the file it resolves to (`realpath`), against the folders' own real paths. Both must be inside, outside a dot segment, and of an allowed type. Then `open` with `O_NOFOLLOW`, `O_NONBLOCK`, and `fstat` on the handle. | A link inside the project pointing at `/etc/x.md` or `~/.ssh/…` is refused; a link that stays inside is followed. `O_NONBLOCK` keeps a FIFO named `x.md` from hanging the agent. |
| D6 | Types | `.md`, `.markdown`, `.txt`, compared lowercase on both names. Valid UTF-8 without NUL, else `binary`. `.txt` shows as plain text. | The card's list. |
| D7 | Size | 512 KiB. A bigger file answers `too_large` with its size and no body. | The body travels base64 in one control frame (1 MiB, `frames.ts`); 512 KiB is ~683 KiB encoded. The card's "ex.: 1 MB" does not fit a frame. |
| D8 | Refusals | Every refusal is a `status` (`missing`, `outside`, `hidden`, `type`, `not_file`, `too_large`, `binary`, `eperm`), shown in Portuguese on the preview, never thrown. | The screen says why instead of "erro". |
| D9 | Which machine | With a tab (Sessões), the tab's machine. Otherwise the conversation's project: its linked agent machines, in link order, and the first that has the file wins. The account-wide chat (no project) tries the person's agent machines with home and temp only. A relative path is joined to the project folder of each machine. | Answers carry no machine id (`ChatMessage` has none). Trying the project's machines is cheap: one RPC each, and most projects have one. |
| D10 | Server API | Web: `GET /api/file-preview?path=&project_id=&machine_id=`; app: `GET /api/m/v1/file-preview?path=&project_id=&tab_id=`. Both under the `terminals` resource (read), scoped by owner, zod-validated, one shared core. Content is relayed, never stored or logged (only machine id, status and size). | Reading a file on a machine is terminal-level access. Same rule as transcripts (tab chat D4). |
| D11 | Detection | A path is linked when it ends in `.md` or `.markdown`, is absolute, `~/…` or relative (`docs/x.md`, `./x.md`), and is not part of a URL. Found in plain text and inline code, never inside code blocks. Same rules on web and app (one function each, same test table). | `.txt` is not linked: `requirements.txt` would be noise. It can still open from a link inside a previewed file. |
| D12 | Rendering, web | The chat's sanitizer (`markdownOnly`): Markdown's own tags only, no raw HTML that fetches, no `<img>`. An image becomes a link "imagem: alt" that opens only on click. External links open in a new tab with `noopener noreferrer`. A relative `.md` link inside the file opens another preview. Code blocks get the chat's copy button. | Reuses the one audited boundary. "No remote images without consent": the click is the consent. |
| D13 | Rendering, app | `react-native-markdown-display` with an image rule that shows a tappable "imagem: alt" (opens the browser only on tap), a link rule that opens previews for relative `.md` and the browser for `http(s)` only. No `html` rendering (the library does not render raw HTML). | Same policy as the web, no new native module (so it ships by OTA). |
| D14 | Web UI | A file tab in the project's tab bar, id `file:<machine_id>:<path>`. Single click on a path link opens it as the preview tab, double click (or the pin button) pins it, ✕ closes it. Kept in the same per-project store as terminal tabs. The view: header with path, machine, size, "Atualizar", "Copiar", "Baixar", "Abrir no GitHub" (when the file is inside the project folder and the project has a repository) and "Mandar para o chat". | The maintainer's decision. File tabs live in the same `EditorTabs` list, so order, preview and pin behave the same; a link in the global chat goes to `/projects/:id?file=…`. |
| D15 | App UI | A stack screen `file-preview` (params: path, project_id, tab_id). Header actions: copy, share (the app's "download": the system share sheet with the text), open on GitHub, send to chat. | Phones have no tab bar; a pushed screen is the app's preview. |
| D16 | "Mandar para o chat" | The client uploads the text it already has as a chat attachment (`name.md`, existing upload route and limits) and adds it to the project chat's composer, not sent. | Reuses attachments; the person still chooses to send. |
| D17 | Out of scope | The file browser (recent `.md` of the project) is a follow-up card. The web gets no tab-chat view; "resposta da aba" on the web is the concierge's relay. | The card marks the browser optional. |

## 3. Agent: `file.read`

`packages/agent-protocol`: `file.read` params `{ path: machinePath, roots: machinePath[] (≤16) }`,
result `{ status: 'ok', path, size, mtime_ms, content_b64 }` or `{ status: <refusal>, size? }`;
`FILE_READ_MAX_BYTES`, `FILE_READ_EXTENSIONS`, `FILE_READ_REFUSALS`; `CAPABILITY_FILE_READ = 'file_read'`.

`apps/agent/src/rpc/file-read.ts`, in order: folders (D3), the path as written (inside, D4, D6), `realpath`
(missing/eperm), the real path against the folders' real paths (D5), `stat` regular file, `open`
`O_NOFOLLOW|O_NONBLOCK`, `fstat`, read at most limit + 1 bytes (D7), UTF-8 check (D6).

## 4. Server

`requireFileReadCapable(machine)` next to `requireTranscriptCapable` (400/503/409). `file-preview/core.ts`
resolves candidates (D9), calls `agentRpc(machine, 'file.read', …)`, decodes the body and answers:

```ts
{ status: 'ok', machine: { id, name }, path, rel_path: string | null, size, mtime, content, github_url: string | null }
| { status: <refusal>, machine: { id, name } | null, size?: number }
```

When no candidate can answer: every candidate offline → 503 `AGENT_OFFLINE`; one has an old agent and
none had the file → 409 `AGENT_OUTDATED`. `github_url` = `https://github.com/<full_name>/blob/<base_branch>/<rel_path>`.
The contract lives in `packages/mobile-api` (`filePreview…`) and the web route answers the same shape.

## 5. Web and app

Web: `lib/md-paths.ts` (detection), a pass in `ChatTurn`'s `toHtml` that wraps paths in
`<a data-md-path>` after sanitizing, clicks caught by the turn's delegated handler; `FileView` component;
`editor-tabs` learns file ids (`pruneEditorTabs` keeps them). App: `md-paths.ts` (same table),
`MessageBubble` gets a `rules.text`-level linkify through `onLinkPress` on a `termhub-file:` scheme, the
`file-preview` route, the store, the mock handler, and the "Atualize o agente" state.

## 6. Tests

- Agent: each allowed folder; outside; `..`; `/` refused as folder; config file folders; dot folders and
  dot files; links out, links to dot folders, linked folders out, `.md` link to another type, links that
  stay in, linked project folder, dangling links; each type; directory; FIFO; size at and over the limit;
  NUL and invalid UTF-8; missing; `eperm`.
- Protocol: params and both result shapes.
- Server: capability gate (400/503/409), candidate order and first-hit, relative path joined to cwd, scope
  (another owner's project or tab → 404), `github_url`, no body logged.
- Web: detection table, sanitizer of the preview (script, `on*`, `javascript:`, every fetching tag of
  `markdown.test.ts`, images as links), file tabs in `editor-tabs`.
- App: detection table, image and link rules, outdated agent state.

## 7. Impact on other users

Everyone who reads chat answers sees `.md` paths become links; nothing opens or is read until a click.
Reading needs agent 0.16.0 on that machine (others see "Atualize o agente"). The allowed folders are the
same for everyone by default; widening them is opt-in per machine, by its owner, in
`~/.termhub/file-read-roots`. No setting changes and no data is stored.
