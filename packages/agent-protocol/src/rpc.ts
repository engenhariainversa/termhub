import { z } from 'zod';

export const SESSION_RE = /^[A-Za-z0-9_-]+$/;
export const sessionName = z.string().min(1).max(128).regex(SESSION_RE);
/** Absolute, or "~" / "~/…" (expanded on the machine). No NUL or newline. */
export const machinePath = z.string().min(1).max(4096).refine((p) => (p === '~' || p.startsWith('~/') || p.startsWith('/')) && !/[\0\n\r]/.test(p), 'invalid path');
/** Sanitized file name: what paste-file.safeName() produces. */
export const pasteName = z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/);
/** A `docs/superpowers/{specs,plans}/*.md` or `docs/lessons/*.md` file (spec D15; lessons: spec
 *  2026-09-27 failure lessons), relative to the link's cwd. No `..`, no nesting, and never
 *  `docs/lessons/README.md` (the format's own doc, not a lesson). */
export const DOC_PATH_RE = /^docs\/(?:superpowers\/(?:specs|plans)\/[A-Za-z0-9._-]{1,200}\.md|lessons\/(?!README\.md$)[A-Za-z0-9._-]{1,200}\.md)$/;
export const docPath = z.string().regex(DOC_PATH_RE);
export const aiProvider = z.enum(['claude', 'chatgpt', 'gemini', 'antigravity']);

/** A tab id, as minted by the server (see @termhub/machine-ops TAB_ID_RE, which this must match). */
export const TAB_ID_RE = /^[a-z0-9]{1,64}$/;
export const tabId = z.string().regex(TAB_ID_RE);
export const tabMcpFile = z.enum(['mcp.json', 'token']);

/** Simulator UDID as `xcrun simctl` prints it. The same regex lives in `@termhub/machine-ops`
 *  (`simulator.ts`), which cannot depend on this package; the server's tests assert they match. */
export const UDID_RE = /^[A-Fa-f0-9-]{8,64}$/;
export const udid = z.string().regex(UDID_RE);

/** The only ports a `tcp` channel may reach on the machine: the WDA runner's HTTP (8100–8199) and MJPEG
 *  (9100–9199) ports, derived from the UDID in `apps/server/src/simulator/ports.ts`. Loopback only. */
export function isWdaPort(port: number): boolean {
  return Number.isInteger(port) && ((port >= 8100 && port <= 8199) || (port >= 9100 && port <= 9199));
}
export const wdaPort = z.number().int().refine(isWdaPort, 'port outside the WDA ranges');

/** The only keys a terminal tool may press (spec §4.2): no arbitrary key names reach tmux. `BTab` is
 *  Shift+Tab, Claude Code's mode switch, since agent 0.15.0: the server sends it only to an agent
 *  that advertises `CAPABILITY_TRANSCRIPT`, because an older agent's schema refuses it. */
export const TMUX_KEYS = ['Enter', 'Escape', 'C-c', 'Up', 'Down', 'Tab', 'y', 'n', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'BTab'] as const;
export const tmuxKey = z.enum(TMUX_KEYS);
export type TmuxKey = (typeof TMUX_KEYS)[number];

export const TEXT_MAX_CHARS = 4000;

/** A shrunk transcript line larger than this travels as a stub (`termhub_dropped`). */
export const TRANSCRIPT_LINE_MAX_BYTES = 65_536;

export const rpcErrorSchema = z.object({
  /** `failed`: the operation ran on the machine and `message` says why it failed, in words meant for the user.
   *  `refused`: a `tcp` open found nothing listening on the port (ECONNREFUSED). */
  code: z.enum(['eperm', 'notfound', 'no_tmux', 'timeout', 'invalid', 'internal', 'failed', 'refused']),
  message: z.string().max(2000),
  path: z.string().max(4096).optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

const DEFAULT_TIMEOUT = 8_000;
const def = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(params: P, result: R, timeoutMs = DEFAULT_TIMEOUT) => ({ params, result, timeoutMs });

export const RPC = {
  'tmux.list': def(z.object({}), z.object({ sessions: z.array(sessionName) })),
  'tmux.kill': def(z.object({ session: sessionName }), z.object({ killed: z.boolean() })),
  /**
   * `escapes`: keep the SGR attributes (`capture-pane -e`) so the server can tell dimmed text from typed
   * text (since agent 0.5.2). An older agent strips the unknown param and answers plain text with no
   * `escapes` in the result — which is how the server knows.
   */
  'tmux.capture': def(
    z.object({ session: sessionName, lines: z.number().int().min(1).max(5000), escapes: z.boolean().optional() }),
    z.object({ text: z.string(), escapes: z.boolean().optional() }),
  ),
  /** Idempotent: creates the detached session in `cwd` when it is missing. `created` says whether it had to. */
  'tmux.ensure': def(z.object({ session: sessionName, cwd: machinePath }), z.object({ created: z.boolean() }), 10_000),
  /**
   * Types `text` literally, then (with `enter`) presses Enter on its own after a short pause.
   * `paste`: deliver `text` as a tmux buffer paste instead of typed keystrokes, so a TUI reads
   * an embedded newline as part of the pasted text rather than as Enter (since agent 0.3.0).
   */
  'tmux.sendText': def(z.object({ session: sessionName, text: z.string().max(TEXT_MAX_CHARS), enter: z.boolean(), paste: z.boolean().optional() }), z.object({ sent: z.literal(true) }), 10_000),
  'tmux.sendKey': def(z.object({ session: sessionName, key: tmuxKey }), z.object({ sent: z.literal(true) }), 10_000),
  /**
   * A mouse-wheel scroll over the tab (TER-465): `lines` < 0 up, > 0 down, 0 leaves copy-mode. What it
   * does depends on the pane (copy-mode, alternate screen, Codex in front): see `buildScrollScript` in
   * `@termhub/machine-ops`, which the agent runs as is (since agent 0.12.0).
   */
  'tmux.scroll': def(z.object({ session: sessionName, lines: z.number().int().min(-500).max(500) }), z.object({ done: z.literal(true) })),
  /**
   * What the tab's pane runs in front (TER-643): `shell` once the agent on top of the shell exited,
   * `busy` while anything else holds the terminal, `dead` for a pane whose process is gone. See
   * `buildPaneForegroundScript` in `@termhub/machine-ops`, which the agent runs as is (since agent 0.14.0).
   */
  'tmux.foreground': def(z.object({ session: sessionName }), z.object({ pane: z.enum(['shell', 'busy', 'dead']) })),
  'tools.detect': def(z.object({}), z.object({ os: z.string().nullable(), tools: z.array(z.string().max(32)) })),
  'hw.probe': def(z.object({}), z.object({ stdout: z.string() }), 15_000),
  'fs.list': def(z.object({ path: machinePath }), z.object({ stdout: z.string() })),
  'fs.mkdir': def(
    z.object({
      parent: machinePath,
      name: z.string().min(1).max(255).regex(/^[^/\\\0\n\r]+$/),
      /** `mkdir -p`: create missing parents too (ensureDirectory parity with the ssh/local branch). Default: leaf only. */
      recursive: z.boolean().optional(),
    }),
    z.object({ stdout: z.string() }),
  ),
  'ai.credential': def(z.object({ provider: aiProvider, config_dir: machinePath.nullable() }), z.object({ stdout: z.string() }), 10_000),
  /**
   * A secret the machine already holds, read for the server to store encrypted (spec 2026-09-28 MCP
   * integrations D1/D2). One source only: `gh_auth_token` (`gh auth token`); new sources are added one
   * by one, never a generic file or command (since agent 0.9.0).
   */
  'secret.read': def(z.object({ source: z.enum(['gh_auth_token']) }), z.object({ value: z.string().max(4096) }), 10_000),
  /** Symlinks a Claude Code transcript into another account's config dir so `claude --resume` finds it there (since agent 0.7.0). */
  'claude.linkSession': def(
    z.object({
      transcript_path: machinePath,
      session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      config_dir: machinePath.nullable(),
    }),
    z.object({ status: z.enum(['linked', 'same_account', 'no_transcript', 'no_config_dir', 'conflict']) }),
    10_000,
  ),
  /**
   * Lines of a Claude Code transcript by byte range (spec 2026-10-01 tab chat §4). The agent knows
   * nothing about a line's shape: it keeps the lines whose `type` is in `types`, truncates every
   * string longer than `max_string` and replaces a line still over TRANSCRIPT_LINE_MAX_BYTES by a
   * stub. `forward` reads from `offset`; `backward` reads what ends at `offset` (null: the end of
   * the file). `start`/`end` are the byte range covered, on line boundaries. `missing`: no such
   * transcript, here or in the account's other project dirs (since agent 0.15.0).
   */
  'transcript.read': def(
    z.object({
      transcript_path: machinePath,
      session_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      direction: z.enum(['forward', 'backward']),
      offset: z.number().int().min(0).nullable(),
      max_bytes: z.number().int().min(1024).max(512 * 1024),
      types: z.array(z.string().min(1).max(32)).min(1).max(16),
      max_string: z.number().int().min(256).max(16_384),
    }),
    z.object({
      status: z.enum(['ok', 'missing']),
      lines: z.array(z.string()),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
      size: z.number().int().min(0),
    }),
    10_000,
  ),
  'file.paste': def(z.object({ name: pasteName, data_b64: z.string().min(1).max(28 * 1024 * 1024) }), z.object({ path: z.string() }), 60_000),
  /** Monitor hooks (see @termhub/machine-ops hooks.ts): the agent writes the script, env and config entries under its own $HOME. */
  /** `claude_dirs`: Claude config dirs besides ~/.claude (accounts with CLAUDE_CONFIG_DIR), hooked when they exist; since agent 0.1.5. */
  /** `cursor` in the result: ~/.cursor/hooks.json (Cursor CLI), written when ~/.cursor exists; since agent 0.4.3 (older agents leave it out). */
  'hooks.install': def(
    z.object({
      hooks_url: z.string().min(1).max(2048).regex(/^https?:\/\/[^\s'"]+$/),
      token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/),
      claude_dirs: z.array(machinePath).max(16).optional(),
    }),
    z.object({
      home: z.string(),
      claude: z.enum(['installed', 'skipped']),
      codex: z.enum(['installed', 'skipped']),
      cursor: z.enum(['installed', 'skipped']).optional(),
      claude_dirs: z.array(z.string()).optional(),
    }),
    15_000,
  ),
  'hooks.uninstall': def(z.object({ claude_dirs: z.array(machinePath).max(16).optional() }), z.object({ removed: z.boolean() }), 15_000),
  /** Installs `version` of @termhub/agent with npm; when the agent runs as a service it then exits so the service relaunches the new code (since agent 0.2.1). */
  'agent.update': def(
    z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
    z.object({ installed_version: z.string(), restart: z.enum(['service', 'manual']) }),
    180_000,
  ),
  /** iOS simulator over the agent (spec 2026-09-24): raw `xcrun simctl list devices -j`; the server parses it. */
  'sim.list': def(z.object({}), z.object({ stdout: z.string() }), 15_000),
  /** `xcrun simctl boot`; combined output, "already booted" included — the server decides what is a failure. */
  'sim.boot': def(z.object({ udid }), z.object({ stdout: z.string() }), 60_000),
  /** Starts the WDA runner in its tmux session; `started: false` when the session already existed. */
  'wda.runner.start': def(z.object({ udid, wda_port: wdaPort, mjpeg_port: wdaPort }), z.object({ started: z.boolean() }), 10_000),
  'wda.runner.alive': def(z.object({ udid }), z.object({ alive: z.boolean() })),
  'wda.runner.tail': def(z.object({ udid, lines: z.number().int().min(1).max(200) }), z.object({ lines: z.array(z.string()) })),
  /** Writes ~/.termhub/wda-setup.sh and runs it in tmux `termhub-wda-setup`; `started: false` when already running. */
  'wda.setup.start': def(z.object({}), z.object({ started: z.boolean() }), 10_000),
  /** Raw `STATE:/VERSION:/TAIL:` text; `parseSetupOutput` on the server reads it. */
  'wda.setup.state': def(z.object({}), z.object({ stdout: z.string() })),
  /**
   * Manifest of `docs/superpowers/{specs,plans}/*.md` under `cwd`: `F\t<sha256>\t<size>\t<relpath>`
   * lines, `@termhub/machine-ops`'s `parseDocsScan` reads them back (since agent 0.8.0).
   */
  'docs.scan': def(z.object({ cwd: machinePath }), z.object({ stdout: z.string() }), 15_000),
  /**
   * Base64 bodies for up to 20 chosen paths, each re-validated against the same tree on the
   * machine (defence in depth — `docPath` already restricts what reaches this call); a file over
   * `DOCS_MAX_BYTES` is skipped silently. `parseDocsRead` reads the output back (since agent 0.8.0).
   */
  'docs.read': def(z.object({ cwd: machinePath, paths: z.array(docPath).min(1).max(20) }), z.object({ stdout: z.string() }), 20_000),
  /**
   * Writes a tab's private MCP config file (`~/.termhub/tabs/<tab_id>/<file>`, spec D7): `body`
   * travels only on stdin, never in this params object's serialized form on disk/log (since agent 0.10.0).
   */
  'tab.mcp.write': def(z.object({ tab_id: tabId, file: tabMcpFile, body: z.string().min(1).max(8192) }), z.object({ ok: z.literal(true) }), 10_000),
  /** Deletes a tab's whole MCP config dir on close (spec D12); best effort (since agent 0.10.0). */
  'tab.mcp.remove': def(z.object({ tab_id: tabId }), z.object({ ok: z.literal(true) }), 10_000),
} as const;

export type RpcMethod = keyof typeof RPC;
export const RPC_METHODS = Object.keys(RPC) as RpcMethod[];
export const rpcMethod = z.enum(RPC_METHODS as [RpcMethod, ...RpcMethod[]]);
export type RpcParams<M extends RpcMethod> = z.infer<(typeof RPC)[M]['params']>;
export type RpcResult<M extends RpcMethod> = z.infer<(typeof RPC)[M]['result']>;
