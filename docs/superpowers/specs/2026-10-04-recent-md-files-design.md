# Recent Markdown files of a project — design

TER-953, the follow-up TER-941 left out of scope (file preview spec D17). Agent, server, web and mobile
app; no migration.

## 1. Problem

The file preview (TER-941) opens a `.md` only from a path an answer names. There is no way to see what
the project has: the specs and plans the agents wrote this week, the lessons, the legal drafts, or a
report a tab mentioned two turns ago.

## 2. Decisions

| # | Topic | Decision | Why |
| --- | --- | --- | --- |
| D1 | Lister | A new agent RPC, `file.list`, in Node (no shell), behind the capability `file_list`, agent 0.17.0. `file.read` stays the only reader: the list carries names, sizes and dates, never a body. Older agent: the machine is skipped and the list says "Atualize o agente". | `file.read` reads one file; listing needs `readdir`/`stat`. `docs.scan` has no dates and no `docs/legal`, and is the memory index's contract. |
| D2 | Same rules | `file.list` reuses `file.read`'s checks for every entry: allowed folders (project folder, home, temp dirs, `~/.termhub/file-read-roots`), no dot segment below the folder, the link target inside a folder too, type by extension (`.md`, `.markdown` only — `.txt` is not listed), regular file (via `stat`, never `open`, so a FIFO cannot block), and at most `FILE_READ_MAX_BYTES` (a bigger file is listed with `too_large: true`, so the screen says why it will not open). A refused entry is left out silently. | One audited policy. |
| D3 | What is listed | Repository docs: the non-recursive `.md`/`.markdown` files of `docs/superpowers/specs`, `docs/superpowers/plans`, `docs/lessons` (without `README.md`) and `docs/legal`, under each linked machine's project folder. Cited files: the Markdown paths (same detection as the chat, D11 of the preview spec) found in the last whole answer (`tab_last_answers`) and the monitor events' texts (`tab_events`) of the project's tabs on that machine; a relative path is joined to that machine's project folder. | What the card asked for. Answers carry no machine id, but a tab does. |
| D4 | Limits | Server sends at most 8 folders and 100 cited paths per machine; the agent answers at most 500 entries, newest first. The server merges machines, drops duplicates (same machine and resolved path; a file both in a folder and cited keeps both labels), sorts by date and answers at most 300. | One control frame (1 MiB) with room to spare. |
| D5 | Server API | Web: `GET /api/file-recent?project_id=`; app: `GET /api/m/v1/file-recent?project_id=`. Under the `terminals` resource (read) like the preview, scoped by owner, zod-validated, one shared core in `file-preview/`. Answer: `{ items: [{ machine, path, rel_path, name, size, mtime, too_large, group, cited }], skipped: [{ machine, reason: 'offline' \| 'outdated' \| 'unsupported' }] }`. `group`: `specs`, `plans`, `lessons`, `legal` or `other` (cited, outside those folders). Nothing is stored or logged but counts. | Same as the preview (D10). |
| D6 | Web UI | A "Arquivos" entry next to the project's other pages, at `/projects/:id/files`: a filter by group, a search box over the name, rows with name, folder, machine (when the project has more than one), size and relative date. A click opens the file as the preview tab in the project's terminal area (`/projects/:id?file=<path>&machine=<id>`), as a path in the chat does. | The card allowed the side or `/files`; a project page keeps the list next to the tabs it opens into. |
| D7 | App UI | A "Arquivos" entry on the project screen pushes a `file-recent` stack screen with the same groups as chips; a tap pushes the existing `file-preview` screen with `project_id`, `machine_id` and the path. JS only, ships by OTA. | Same pattern as the preview (D15). |
| D8 | FIFO | `file.list` never opens a file, so a FIFO is just "not a regular file". The FIFO test of `file.read` (which hung once in TER-941's local run) is re-run in a loop to check it is stable, and `file.list` gets its own FIFO case. | The card asked to keep an eye on it. |

## 3. Impact on other users

Everyone with a project gets an "Arquivos" page (web) and screen (app), read-only; nothing is read until
they open it, and a file opens only on click. Listing needs agent 0.17.0 (older agents show "Atualize o
agente" for that machine). The allowed folders are the same as the preview's; nothing new is opt-in, no
setting changes and nothing is stored.
