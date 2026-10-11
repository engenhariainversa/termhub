import type { Machine } from '../db/repositories/types.js';
import { badRequest } from '../lib/errors.js';
import { runOnMachine, shellQuote } from './machine-exec.js';
import { PASTE_DIR } from './paste-file.js';
import { tk } from '../i18n/index.js';

/** A file found in ~/.cache/termhub/paste/ on a machine. */
export interface DiskFile {
  name: string;
  bytes: number;
  /** last modification, ISO */
  modified_at: string;
}

export type DirListing = { ok: true; files: DiskFile[] } | { ok: false; error: string };

/** Names are produced by safeName(): "paste-" + [A-Za-z0-9._-]; anything else never reaches a shell. */
const NAME_RE = /^paste-[A-Za-z0-9._-]{1,120}$/;

export function assertUploadName(name: string): void {
  if (!NAME_RE.test(name) || name.includes('..')) throw badRequest('Nome de arquivo inválido');
}

/**
 * Lists the paste directory. GNU stat (Linux) and BSD stat (macOS) differ, so each file tries both;
 * PASTE_DIR is a constant and the glob is fixed — nothing from the client enters the script.
 */
export async function listPasteDir(machine: Machine): Promise<DirListing> {
  // runOnMachine throws for agents (named RPCs only, none lists this directory yet): report it as a machine error instead
  if (machine.type === 'agent') return { ok: false, error: tk('Listagem de arquivos ainda não disponível em máquinas com agente') };
  const script = [
    `d="$HOME/${PASTE_DIR}"`,
    `[ -d "$d" ] || exit 0`,
    `cd "$d" || exit 1`,
    // pick the stat flavour once: GNU (Linux) understands -c, BSD (macOS) wants -f
    `if stat -c '%n' . >/dev/null 2>&1; then for f in paste-*; do [ -f "$f" ] && stat -c '%n\t%s\t%Y' "$f"; done; else for f in paste-*; do [ -f "$f" ] && stat -f '%N\t%z\t%m' "$f"; done; fi; true`,
  ].join('; ');
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 15_000);
  if (r.timedOut) return { ok: false, error: tk('A máquina não respondeu') };
  if (r.code !== 0) return { ok: false, error: machine.type === 'ssh' ? tk('Falha ao conectar via SSH') : tk('Falha ao listar os arquivos') };
  const files: DiskFile[] = [];
  for (const line of r.stdout.split('\n')) {
    const [name, size, mtime] = line.split('\t');
    if (!name || !NAME_RE.test(name)) continue;
    const bytes = Number(size);
    const t = Number(mtime);
    files.push({ name, bytes: Number.isFinite(bytes) ? bytes : 0, modified_at: new Date((Number.isFinite(t) ? t : 0) * 1000).toISOString() });
  }
  return { ok: true, files };
}

/** Removes one file from the paste directory; true when it existed. */
export async function deletePasteFile(machine: Machine, name: string): Promise<boolean> {
  assertUploadName(name);
  const script = `f="$HOME/${PASTE_DIR}/"${shellQuote(name)}; [ -e "$f" ] || exit 3; rm -f -- "$f"`;
  const r = await runOnMachine(machine, { file: '/bin/sh', args: ['-c', script] }, script, 15_000);
  if (r.timedOut) throw new Error('A máquina não respondeu');
  if (r.code === 3) return false;
  if (r.code !== 0) throw new Error(machine.type === 'ssh' ? 'Falha ao conectar via SSH' : 'Falha ao remover o arquivo');
  return true;
}
