import { EXPAND_HOME, buildFsListScript, buildMkdirScript } from '@termhub/machine-ops';
import { basename, dirname } from 'node:path';
import { agentRpc } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { runOnMachine, shellQuote } from './machine-exec.js';
import { tk } from '../i18n/index.js';

export interface FsRoot {
  kind: 'home' | 'disk';
  label: string;
  path: string;
  /** dispositivo / origem do mount (só disk) */
  source?: string;
  size_kb?: number;
  avail_kb?: number;
}

export interface FsEntry {
  name: string;
  path: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  roots: FsRoot[];
}

/** Sistemas de arquivos virtuais que não interessam como "disco". */
const PSEUDO_FS = new Set([
  'tmpfs', 'devtmpfs', 'udev', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'efivarfs', 'devpts',
  'mqueue', 'hugetlbfs', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'none', 'shm',
  'devfs', 'autofs', 'ramfs', 'binfmt_misc', 'nsfs', 'rpc_pipefs', 'map', 'sunrpc', 'systemd-1', 'gvfsd-fuse',
]);
/** Mount points que nunca servem para projeto. */
const EXCLUDED_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/boot', '/var/lib/docker', '/var/snap', '/System/Volumes', '/private/var/vm', '/Volumes/Recovery'];

function isProjectDisk(source: string, mount: string): boolean {
  if (!mount.startsWith('/')) return false;
  if (PSEUDO_FS.has(source) || source.startsWith('fuse.') || source.startsWith('map ')) return false;
  if (EXCLUDED_MOUNT_PREFIXES.some((p) => mount === p || mount.startsWith(p + '/'))) return false;
  return true;
}

function diskLabel(mount: string): string {
  if (mount === '/') return 'Raiz (/)';
  const last = mount.split('/').filter(Boolean).pop();
  return last ?? mount;
}

function parseOutput(stdout: string): { home: string | null; pwd: string | null; err: string | null; dirs: string[]; mounts: FsRoot[] } {
  let home: string | null = null;
  let pwd: string | null = null;
  let err: string | null = null;
  const dirs: string[] = [];
  const mounts: FsRoot[] = [];
  for (const line of stdout.split('\n')) {
    if (line.startsWith('HOME:')) home = line.slice(5) || null;
    else if (line.startsWith('PWD:')) pwd = line.slice(4).replace(/^\/{2,}/, '/') || null;
    else if (line.startsWith('ERR:')) err = line.slice(4);
    else if (line.startsWith('DIR:')) dirs.push(line.slice(4));
    else if (line.startsWith('MNT:')) {
      const [source, size, avail, mount] = line.slice(4).split('\t');
      if (!source || !mount || !isProjectDisk(source, mount)) continue;
      const sizeKb = Number(size);
      const availKb = Number(avail);
      mounts.push({
        kind: 'disk',
        label: diskLabel(mount),
        path: mount,
        source,
        size_kb: Number.isFinite(sizeKb) ? sizeKb : undefined,
        avail_kb: Number.isFinite(availKb) ? availKb : undefined,
      });
    }
  }
  return { home, pwd, err, dirs, mounts };
}

function parentOf(path: string): string | null {
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Maps a `fs.list`/buildFsListScript ERR: tag to the HTTP error, the same way in every
 * caller (browseMachine, ensureDirectory) so a non-directory or inaccessible path never
 * silently passes through as a valid one. No-op when `err` is null (no error reported).
 */
function throwFsListError(err: string | null): void {
  if (err === 'notfound') throw notFound('Diretório não existe na máquina');
  if (err === 'eperm') throw forbidden('Sem acesso à pasta na máquina');
  if (err === 'notdir') throw badRequest('O caminho não é um diretório');
  if (err === 'denied') throw forbidden('Sem permissão para acessar o diretório');
}

/** Lista subdiretórios de `path` (padrão: $HOME) e os discos/mounts da máquina. */
export async function browseMachine(machine: Machine, path: string | undefined): Promise<FsListing> {
  const raw = (path ?? '').trim();
  if (raw.includes('\0') || raw.includes('\n')) throw badRequest('Caminho inválido');
  if (raw && raw !== '~' && !raw.startsWith('~/') && !raw.startsWith('/')) throw badRequest('Informe um caminho absoluto');

  let stdout: string;
  if (machine.type === 'agent') {
    ({ stdout } = await agentRpc(machine, 'fs.list', { path: raw || '~' }));
  } else {
    const script = buildFsListScript(shellQuote(raw));
    const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
    if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder');
    if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? tk('Máquina inacessível via SSH') : tk('Falha ao listar diretórios'));
    stdout = r.stdout;
  }

  const out = parseOutput(stdout);
  throwFsListError(out.err);
  if (!out.pwd) throw new HttpError(502, 'Resposta inesperada da máquina');

  const roots: FsRoot[] = [];
  if (out.home) roots.push({ kind: 'home', label: 'Home', path: out.home });
  // dedup por mount point (macOS repete o mesmo volume) e ordena: "/" primeiro, depois alfabético
  const seen = new Set<string>();
  for (const m of out.mounts.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)))) {
    if (seen.has(m.path)) continue;
    seen.add(m.path);
    roots.push(m);
  }

  const base = out.pwd === '/' ? '' : out.pwd;
  return {
    path: out.pwd,
    parent: parentOf(out.pwd),
    entries: out.dirs.map((name) => ({ name, path: `${base}/${name}` })),
    roots,
  };
}

const DIR_NAME_RE = /^[^/\\\0\n\r]{1,255}$/;
/** Nome de pasta simples: sem separadores, sem "." ou "..", sem controle. */
export function assertDirName(name: string): void {
  if (!DIR_NAME_RE.test(name) || name === '.' || name === '..' || /[\x00-\x1f]/.test(name)) throw badRequest('Nome de pasta inválido');
}

async function runFsScript(machine: Machine, script: string): Promise<string> {
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 10000);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para responder');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? tk('Máquina inacessível via SSH') : tk('Falha ao acessar o sistema de arquivos'));
  return r.stdout;
}

function firstTag(stdout: string, tag: string): string | null {
  const line = stdout.split('\n').find((l) => l.startsWith(tag + ':'));
  return line ? line.slice(tag.length + 1).replace(/^\/{2,}/, '/') : null;
}

/** Cria `name` dentro de `parent` na máquina e devolve o caminho absoluto da nova pasta. */
export async function makeDirectory(machine: Machine, parent: string, name: string): Promise<string> {
  assertDirName(name);
  const raw = parent.trim();
  if (!raw.startsWith('/') && raw !== '~' && !raw.startsWith('~/')) throw badRequest('Informe um caminho absoluto');
  let out: string;
  if (machine.type === 'agent') {
    ({ stdout: out } = await agentRpc(machine, 'fs.mkdir', { parent: raw, name }));
  } else {
    const script = buildMkdirScript(shellQuote(raw), shellQuote(name));
    out = await runFsScript(machine, script);
  }
  const err = firstTag(out, 'ERR');
  if (err === 'parent') throw notFound('A pasta de destino não existe na máquina');
  if (err === 'exists') throw conflict('Já existe um arquivo ou pasta com esse nome');
  if (err === 'denied') throw forbidden('Sem permissão para criar a pasta');
  const pwd = firstTag(out, 'PWD');
  if (!pwd) throw new HttpError(502, 'Resposta inesperada da máquina');
  return pwd;
}

/** ensureDirectory's error vocabulary — one table for both the ssh/local script and the agent branch. */
const ENSURE_ERRORS = {
  notfound: () => new HttpError(400, 'A pasta não existe na máquina. Marque "criar a pasta" ou escolha outra.', 'DIR_NOT_FOUND'),
  notdir: () => badRequest('O caminho existe, mas não é uma pasta'),
  denied: () => forbidden('Sem permissão para acessar a pasta'),
  mkdir: () => forbidden('Não foi possível criar a pasta (permissão?)'),
} as const;

function throwEnsureError(err: string | null): void {
  if (err === null) return;
  // fs.list reports an unreadable/unsearchable directory as `eperm`; the ssh script has no
  // such probe and reports the same situation as `denied` (its `cd` fails) — same answer.
  const key = err === 'eperm' ? 'denied' : err;
  const make = (ENSURE_ERRORS as Record<string, () => HttpError>)[key];
  if (make) throw make();
}

/**
 * Confere que `path` é um diretório na máquina (expande "~"), criando com mkdir -p se `create`.
 * Devolve o caminho absoluto resolvido, que é o que deve ser gravado no projeto.
 */
export async function ensureDirectory(machine: Machine, path: string, create: boolean): Promise<{ path: string; created: boolean }> {
  const raw = path.trim();
  if (!raw.startsWith('/') && raw !== '~' && !raw.startsWith('~/')) throw badRequest('Informe um caminho absoluto');

  if (machine.type === 'agent') {
    // No dedicated RPC for "ensure": both branches start with fs.list to check the path exists,
    // matching the ssh/local script's own "already a directory -> created:false" short-circuit.
    // Errors use the same statuses/messages as the script below (DIR_NOT_FOUND drives the
    // "criar a pasta" hint in the UI).
    const listed = await agentRpc(machine, 'fs.list', { path: raw });
    const listOut = parseOutput(listed.stdout);
    if (!listOut.err) return { path: listOut.pwd ?? raw, created: false };
    if (listOut.err !== 'notfound' || !create) throwEnsureError(listOut.err);

    // Missing and create === true: `recursive` is the agent-side `mkdir -p`, so a nested new
    // path (`~/code/new-org/new-repo`) is created the same way the script below creates it.
    const { stdout } = await agentRpc(machine, 'fs.mkdir', { parent: dirname(raw), name: basename(raw), recursive: true });
    const err = firstTag(stdout, 'ERR');
    if (err === 'exists') throw conflict('Já existe um arquivo ou pasta com esse nome');
    if (err === 'parent' || err === 'denied') throw ENSURE_ERRORS.mkdir();
    const pwd = firstTag(stdout, 'PWD');
    if (!pwd) throw new HttpError(502, 'Resposta inesperada da máquina');
    return { path: pwd, created: true };
  }

  const script = [
    `P=${shellQuote(raw)}`,
    EXPAND_HOME,
    `if [ -d "$P" ]; then cd -- "$P" 2>/dev/null && echo "PWD:$(pwd)" || echo "ERR:denied"; exit 0; fi`,
    `if [ -e "$P" ]; then echo "ERR:notdir"; exit 0; fi`,
    create ? `mkdir -p -- "$P" 2>/dev/null && cd -- "$P" && echo "CREATED:$(pwd)" || echo "ERR:mkdir"` : `echo "ERR:notfound"`,
    `exit 0`,
  ].join('; ');
  const out = await runFsScript(machine, script);
  throwEnsureError(firstTag(out, 'ERR'));
  const created = firstTag(out, 'CREATED');
  const pwd = created ?? firstTag(out, 'PWD');
  if (!pwd) throw new HttpError(502, 'Resposta inesperada da máquina');
  return { path: pwd, created: created != null };
}
