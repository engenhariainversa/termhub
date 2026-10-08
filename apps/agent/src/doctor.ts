import { ensureSpawnHelperExecutable } from './pty-health.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, readConfig } from './config.js';
import { checkServerConnection, type ServerConnectionCheck } from './run.js';
import { sh } from './exec.js';
import { checkUrl, type UrlCheck } from './rpc/net.js';

export interface DoctorReport {
  config: { ok: boolean; path: string };
  server: { ok: boolean; error?: string };
  /** The monitor hooks and MCP addresses the server named in its probe answer (none from a server older than TER-586). */
  endpoints: EndpointReport[];
  tmux: { ok: boolean; path?: string };
  nodePty: { ok: boolean; error?: string };
  spawnHelper: { ok: boolean; path: string | null; repaired: boolean; error?: string };
  paths: { path: string; ok: boolean; error?: string }[];
}

export interface EndpointReport {
  name: 'hooks' | 'mcp';
  url: string;
  host: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

export interface DoctorDeps {
  /** Only the slice `runDoctor` uses, so tests can inject a fake without touching the real filesystem. */
  fs?: Pick<typeof fs, 'readdirSync'>;
  connect?: typeof checkServerConnection;
  check?: (url: string) => Promise<UrlCheck>;
}

/**
 * termhub answers 401 to a POST without a token on both addresses, so 401 is the only answer that proves
 * the request reached the app: a proxy, a firewall page or a Cloudflare Access login answers something else.
 */
export function endpointReport(name: EndpointReport['name'], check: UrlCheck): EndpointReport {
  let host = check.url;
  try {
    host = new URL(check.url).host;
  } catch {
    /* the server sent a valid URL; keep the raw text otherwise */
  }
  return { name, url: check.url, host, ok: check.status === 401, status: check.status, error: check.error };
}

const SERVER_CHECK_TIMEOUT_MS = 5_000;

/** `$HOME`, `$HOME/Documents`, `$HOME/Desktop`, plus every directory directly under `/Volumes` on macOS. */
export function defaultDoctorPaths(): string[] {
  const home = os.homedir();
  const paths = [home, path.join(home, 'Documents'), path.join(home, 'Desktop')];
  if (process.platform === 'darwin') {
    try {
      for (const entry of fs.readdirSync('/Volumes', { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(path.join('/Volumes', entry.name));
      }
    } catch {
      /* /Volumes unreadable — nothing to add beyond HOME/Documents/Desktop */
    }
  }
  return paths;
}

/** `EPERM`/`EACCES` → `'eperm'` (the code `formatDoctor` recognizes for the Full Disk Access note); anything else is passed through. */
function pathErrorCode(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === 'EPERM' || e?.code === 'EACCES') return 'eperm';
  if (e?.code) return e.code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks one path's `readdirSync`. Exported on its own (not just inline in `runDoctor`) so
 * `service install` (`commands/service.ts`) can run the same $HOME check without paying for
 * `runDoctor`'s server/tmux/node-pty probes, which it has no use for.
 */
export function checkPathAccess(p: string, fsImpl: Pick<typeof fs, 'readdirSync'> = fs): { path: string; ok: boolean; error?: string } {
  try {
    fsImpl.readdirSync(p);
    return { path: p, ok: true };
  } catch (err) {
    return { path: p, ok: false, error: pathErrorCode(err) };
  }
}

/** The Full Disk Access sentence shared by `formatDoctor` (an `eperm` path row) and `service install`. */
export function fullDiskAccessNote(execPath: string = process.execPath): string {
  return `Conceda Acesso Total ao Disco a ${execPath} em Ajustes → Privacidade e Segurança → Acesso Total ao Disco`;
}

export async function runDoctor(paths: string[], deps: DoctorDeps = {}): Promise<DoctorReport> {
  const fsImpl = deps.fs ?? fs;
  const connect = deps.connect ?? checkServerConnection;

  const config = readConfig();
  const configReport = { ok: config !== null, path: configPath() };

  const probe: ServerConnectionCheck = config ? await connect(config, SERVER_CHECK_TIMEOUT_MS) : { ok: false, error: 'sem configuração' };
  const server = { ok: probe.ok, ...(probe.error ? { error: probe.error } : {}) };

  // The hooks post with curl and the tabs' MCP is a plain HTTP client, both to addresses that may sit on
  // another host than /agent/ws (termhub.dev vs app.termhub.dev): a firewall that only lets the latter
  // through leaves the agent connected and the monitor silent (TER-586).
  const check = deps.check ?? ((url: string) => checkUrl(url));
  const targets: [EndpointReport['name'], string][] = [];
  if (probe.endpoints) {
    targets.push(['hooks', probe.endpoints.hooks_url]);
    if (probe.endpoints.mcp_url) targets.push(['mcp', probe.endpoints.mcp_url]);
  }
  const endpoints = await Promise.all(targets.map(async ([name, url]) => endpointReport(name, await check(url))));

  const tmuxCheck = await sh('command -v tmux');
  const tmux = { ok: tmuxCheck.code === 0, path: tmuxCheck.code === 0 ? tmuxCheck.stdout.trim() || undefined : undefined };

  let nodePty: DoctorReport['nodePty'];
  try {
    await import('node-pty');
    nodePty = { ok: true };
  } catch (err) {
    nodePty = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const pathsReport = paths.map((p) => checkPathAccess(p, fsImpl));

  const helper = ensureSpawnHelperExecutable();
  const spawnHelper = { ok: helper.executable, path: helper.path, repaired: helper.repaired, ...(helper.error ? { error: helper.error } : {}) };
  return { config: configReport, server, endpoints, tmux, nodePty, spawnHelper, paths: pathsReport };
}

export interface FormatDoctorDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
}

function mark(ok: boolean): string {
  return ok ? '✓' : '✗';
}

/** pt-BR lines with ✓/✗ per check; a macOS `eperm` path gets a follow-up line pointing at Full Disk Access. */
export function formatDoctor(report: DoctorReport, deps: FormatDoctorDeps = {}): string {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  const lines: string[] = [];

  lines.push(`${mark(report.config.ok)} Configuração (${report.config.path})`);
  lines.push(`${mark(report.server.ok)} Servidor${report.server.ok ? '' : report.server.error ? `: ${report.server.error}` : ''}`);
  for (const e of report.endpoints) {
    const label = e.name === 'hooks' ? 'Hooks do monitor' : 'MCP das abas';
    const detail = e.ok ? '' : e.status !== null ? `: respondeu HTTP ${e.status} (esperado 401)` : `: ${e.error ?? 'sem resposta'}`;
    lines.push(`${mark(e.ok)} ${label} (${e.host})${detail}`);
    if (!e.ok) lines.push(`  → libere ${e.url} no firewall/proxy desta máquina`);
  }
  lines.push(`${mark(report.tmux.ok)} tmux${report.tmux.path ? ` (${report.tmux.path})` : ''}`);
  lines.push(`${mark(report.nodePty.ok)} node-pty${report.nodePty.ok ? '' : report.nodePty.error ? `: ${report.nodePty.error}` : ''}`);
  const sh = report.spawnHelper;
  if (sh.path) {
    lines.push(`${mark(sh.ok)} spawn-helper do node-pty ${sh.ok ? (sh.repaired ? '(permissão de execução corrigida agora)' : 'executável') : `sem permissão de execução${sh.error ? `: ${sh.error}` : ''}`}`);
    if (!sh.ok) lines.push(`  → rode: chmod +x "${sh.path}"`);
  }

  for (const p of report.paths) {
    lines.push(`${mark(p.ok)} ${p.path}${p.ok ? '' : p.error ? `: ${p.error}` : ''}`);
    if (!p.ok && p.error === 'eperm' && platform === 'darwin') {
      lines.push(`  → ${fullDiskAccessNote(execPath)}`);
    }
  }

  return lines.join('\n');
}
