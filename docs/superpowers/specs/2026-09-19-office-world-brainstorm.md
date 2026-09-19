# Office world: an animated, navigable view of machines, projects and tabs — brainstorm

Date: 2026-09-19. Status: **brainstorm notes, not an approved spec.** Parked in the backlog;
the renderer choice and the sectioned design are still pending (see "Next steps").

## 1. The idea

A full-screen view where the account's work is drawn as a small pixel-art world, in the
spirit of Habbo Hotel (isometric rooms, little avatars sitting at desks):

| termhub | in the world |
|---|---|
| Machine | a company (a building) |
| Project | a room inside the building |
| Terminal tab | a person sitting at a desk in that room |
| Simulator tab | a phone on a desk (not a person) |

It is **functional, not decorative**: it is a way to see what is being worked on, who
needs you, how far along each piece of work is, and to jump to the terminal by clicking
the person. The navigation zooms through levels and skips levels that have a single item.

## 2. Decisions taken in conversation

- **Purpose: navigation with live monitoring.** Not a passive wall display only. Clicking
  is the main interaction.
- **Levels and auto-drill.** World → companies → rooms of a company → one room.
  Opening the world with a single company shows its rooms directly; a company with a single
  room opens straight into that room.
- **Click on a person's head opens that terminal in a new browser tab**, at the tab's URL
  (today `/projects/<projectId>?tab=<tabId>`, see `apps/web/src/components/TerminalsView.tsx`).
  Clicking a room opens the project.
- **Progress and time estimate, with a priority order and silence as fallback:**
  1. What Claude Code reports about its own work (its todo list) — shown when available.
  2. Otherwise, the project's kanban: the task in "Fazendo" bound to the tab (`Task.tabId`)
     and its subtasks give the person's progress; the project's tasks give the room's.
  3. Otherwise **nothing is shown**. No invented progress.
  The estimate is best-effort (rate of recent completions); it is not a requirement that it
  exists for every case.
- **Art direction: ready-made pixel art with free licences, isometric, Habbo-like.** No
  in-house artist; own art can replace the packs later if the engine is decoupled from them.
- **2D animated scene rendered by a game-style engine**, not a flat SVG and not 3D.

Context that reinforces the kanban fallback: the concierge (see
`2026-09-19-mobile-chat-concierge-brainstorm.md`) is meant to read tickets from the board
and work on them by itself, eventually deciding on its own. The room showing the board is
what makes that activity visible.

## 3. What already exists and feeds the view

Verified in the repo on 2026-09-19:

- **Per-tab live state.** `Tab.state` is `working | waiting_input | waiting_permission |
  idle | error` (`apps/server/prisma/schema.prisma`), set from Claude Code / Codex hooks
  (`apps/server/src/monitor/state.ts`) or the tmux fallback. This maps one-to-one onto the
  person's animation: typing, hand raised (needs you), asleep at the desk, red/error.
- **Real-time push already reaches the browser.** `/ws/monitor`
  (`apps/server/src/monitor/ws.ts`, fan-out in `monitor/bus.ts`) sends one message per
  state change, scoped to the owner; `MonitorProvider` in `apps/web/src/lib/monitor.tsx`
  holds the snapshot and exposes `tabState(tabId)`. The scene subscribes to that, no polling.
- **"Precisa de você"** (`NeedsYouList`, `NeedsYouToasts`) is the same information; in the
  world it becomes people raising their hands, readable from across the room.
- **Machine status** (online/offline, `useData().statuses`) → building lights on/off.
- **Project status** `active | paused | archived` → room in use / dark / closed.
- **Tasks.** `Task.status` (`backlog | todo | doing | done`), `Task.tabId` binds a running
  task to a tab, `Task.parentId` gives one level of subtasks. Enough for the kanban fallback
  without schema changes.
- **Dashboard grouping** by machine already exists (`ProjectsByMachine.tsx`,
  `api.dashboard()` → `DashboardItem { project, machine, doing, open_tasks }`).

## 4. What is missing

- **Claude Code progress ingestion.** The `PreToolUse` hook already reaches the server, and
  when the tool is `TodoWrite` its input carries the agent's full todo list. Today
  `interpretClaude` deliberately keeps only "busy" from `PreToolUse` and discards the tool
  input (tool input is treated as content). Reading the todo list is an explicit exception
  to that rule and must stay minimal: **store counts only** (done / in-progress / total) and
  at most the active item's title, capped like `stateText`; never the whole list. Codex has
  no equivalent, so Codex tabs fall back to the kanban.
- **A layout generator.** Rooms and desks must be laid out from the data (a machine with
  15 projects and 40 tabs cannot be hand-drawn). Grid-based isometric placement, ordered
  by project position and tab position, with room size derived from tab count.
- **A camera** (zoom + pan between levels) and **tweens** for the level transitions.
- **The route and entry point** in the web app (a new page, plus a "focus" mode that hides
  the surrounding chrome).
- **Sprites.** See section 6.

## 5. Renderer options (recommendation made, not yet confirmed by the user)

1. **PixiJS as renderer, own isometric scene — recommended.** Pixi does sprites,
   spritesheets and containers on WebGL. We write the isometric grid, depth sorting and
   camera (scale + translate of a container). Light bundle, fits React 18 through a component
   that mounts the canvas on a ref and feeds it from `MonitorProvider`. Cost: the isometric
   layout and tween layers are ours, but both are small.
2. **Phaser 3.** Camera, tweens, spritesheet animation and isometric tilemaps out of the box;
   fastest first result. But it is a full engine with its own loop, scenes and lifecycle
   (~1 MB), and embedding it in a React app fed by a WebSocket means two worlds talking
   through events, an ongoing friction.
3. **DOM + CSS.** Elements with `steps()` animations and an isometric `transform`. No
   dependency, native clicks. Degrades past a few dozen sprites and camera zoom becomes
   blurry CSS scaling. Falls short of the Habbo look.

## 6. Art sources (licences to be verified pack by pack before use)

- [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit): 120 objects with
  isometric 2D renders, CC0.
- [itch.io CC0 isometric assets](https://itch.io/game-assets/assets-cc0/tag-isometric):
  floor tiles, town/roof tiles, prototype tiles (buildings for the "world" level).
- [itch.io isometric pixel-art sprites](https://itch.io/game-assets/tag-isometric/tag-pixel-art/tag-sprites)
  and [Kenney isometric collection](https://itch.io/c/4621144/isometric).
- "Isometric Hotel Lobby" (monogon, itch.io) is explicitly Habbo-inspired; licence unknown.
- **Characters are the scarce part**: isometric people with seated/typing/hand-raised
  animations. Expect to combine a furniture pack with a separate character pack, or to have
  a small custom sheet drawn for the 4–5 person states.

## 7. Constraints and risks

- **Scale**: layout must be generated; the building level must cope with many rooms.
- **Privacy**: the scene shows only metadata (names, states, counts, the tool's own message
  already exposed to "precisa de você"). Never terminal content; todo ingestion stores counts.
- **Scope of the monitor**: tabs that never reported a state (`state = null`) are people
  with no animation, not "idle" — the distinction matters for the auto-drill and for
  progress ("nothing" is a valid, honest display).
- **Adoption risk**: a pretty view nobody opens after a week. Mitigation is the click-through
  and the hand-raised signal being useful, not the animation.

## 8. Next steps (to turn this into a spec)

1. Confirm the renderer (recommendation: PixiJS).
2. Sectioned design, one section at a time, each approved before the next:
   levels & navigation; generated room/desk layout; person states & animations (per
   `TabState`, plus simulator tabs); progress & estimate (sources, ingestion change, display);
   where it lives in the app (route, focus mode, permissions).
3. Pick and verify the art packs; define the sprite contract so packs are swappable.
4. Write the spec, then the implementation plan (`writing-plans`).
