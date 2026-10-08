import { ensureSpawnHelperExecutable } from './pty-health.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, readConfig } from './config.js';
import { checkServerConnection } from './run.js';
import { sh } from './exec.js';
import { proxyFor, redactProxy } from './proxy.js';

export interface DoctorReport {
  config: { ok: boolean; path: string };
  server: { ok: boolean; error?: string };
  tmux: { ok: boolean; path?: string };
  nodePty: { ok: boolean; error?: string };
  spawnHelper: { ok: boolean; path: string | null; repaired: boolean; error?: string };
  paths: { path: string; ok: boolean; error?: string }[];
  network: NetworkReport;
}

/**
 * How the agent reaches the server: through which proxy (password hidden), if any, and which
 * extra CA bundle Node trusts (`NODE_EXTRA_CA_CERTS`). `ok` is false for a proxy variable the agent
 * cannot use or a CA file it cannot read.
 */
export interface NetworkReport {
  ok: boolean;
  proxy?: string;
  /** The server matched `NO_PROXY` although a proxy is set. */
  bypassed?: boolean;
  proxyError?: string;
  extraCa?: { path: string; ok: boolean; error?: string };
}

/** The network part of `doctor`, for the server at `url` (when configured) and the variables in `env`. */
export function networkReport(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
  fsImpl: Pick<typeof fs, 'readFileSync'> = fs,
): NetworkReport {
  const report: NetworkReport = { ok: true };
  if (url) {
    try {
      const target = new URL(url);
      const proxy = proxyFor(target, env);
      if (proxy) report.proxy = redactProxy(proxy);
      else if (proxyFor(target, { ...env, no_proxy: '', NO_PROXY: '' })) report.bypassed = true;
    } catch (err) {
      report.ok = false;
      report.proxyError = err instanceof Error ? err.message : String(err);
    }
  }
  const caPath = env.NODE_EXTRA_CA_CERTS?.trim();
  if (caPath) {
    try {
      const pem = fsImpl.readFileSync(caPath, 'utf8');
      report.extraCa = pem.includes('-----BEGIN CERTIFICATE-----') ? { path: caPath, ok: true } : { path: caPath, ok: false, error: 'nenhum certificado PEM no arquivo' };
    } catch (err) {
      report.extraCa = { path: caPath, ok: false, error: pathErrorCode(err) };
    }
    if (!report.extraCa.ok) report.ok = false;
  }
  return report;
}

export interface DoctorDeps {
  /** Only the slice `runDoctor` uses, so tests can inject a fake without touching the real filesystem. */
  fs?: Pick<typeof fs, 'readdirSync'>;
  connect?: typeof checkServerConnection;
  env?: Record<string, string | undefined>;
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

  const server = config ? await connect(config, SERVER_CHECK_TIMEOUT_MS) : { ok: false, error: 'sem configuração' };

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
  const network = networkReport(config?.url, deps.env);
  return { config: configReport, server, tmux, nodePty, spawnHelper, paths: pathsReport, network };
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
  const net = report.network;
  if (net.proxyError) lines.push(`✗ Proxy: ${net.proxyError}`);
  else if (net.proxy) lines.push(`✓ Proxy: ${net.proxy}`);
  else if (net.bypassed) lines.push('✓ Proxy: nenhum para o servidor (NO_PROXY)');
  else lines.push('✓ Proxy: nenhum (conexão direta)');
  if (net.extraCa) {
    lines.push(`${mark(net.extraCa.ok)} CA extra (NODE_EXTRA_CA_CERTS): ${net.extraCa.path}${net.extraCa.ok ? '' : net.extraCa.error ? `: ${net.extraCa.error}` : ''}`);
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
