import { EXT_BY_MIME, PASTE_DIR, PASTE_MAX_BYTES, buildPasteScript, safeName, sniffImage } from '@termhub/machine-ops';
import { agentRpc } from '../agent/errors.js';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { runOnMachineWithInput } from './machine-exec.js';
import { tk } from '../i18n/index.js';

export { PASTE_DIR, PASTE_MAX_BYTES, safeName } from '@termhub/machine-ops';

export interface PastedFile {
  /** absolute path on the target machine */
  path: string;
  /** file name inside PASTE_DIR */
  name: string;
  bytes: number;
  mime: string;
}

/** Writes the file to ~/.cache/termhub/paste/ on the machine and returns its absolute path. */
export async function saveFileOnMachine(machine: Machine, data: Buffer, originalName?: string | null): Promise<PastedFile> {
  if (data.length === 0) throw badRequest('Arquivo vazio');
  if (data.length > PASTE_MAX_BYTES) throw new HttpError(413, 'Arquivo maior que 20 MB');
  const imageMime = sniffImage(data);
  // images get a canonical extension from the signature; anything else keeps its (sanitized) name
  const name = safeName(imageMime ? originalName || `image.${EXT_BY_MIME[imageMime]}` : originalName, imageMime ? EXT_BY_MIME[imageMime] : null);
  const mime = imageMime ?? 'application/octet-stream';

  if (machine.type === 'agent') {
    const { path } = await agentRpc(machine, 'file.paste', { name, data_b64: data.toString('base64') });
    if (!path.startsWith('/')) throw new HttpError(502, 'Resposta inesperada da máquina');
    return { path, name, bytes: data.length, mime };
  }

  // Name is sanitized above (no quotes, spaces or slashes) and PASTE_DIR is fixed: nothing raw from the client enters the command.
  const script = buildPasteScript(name);

  const r = await runOnMachineWithInput(machine, { file: '/bin/sh', args: ['-c', script] }, script, data);
  if (r.timedOut) throw new HttpError(504, 'A máquina demorou para receber o arquivo');
  if (r.code !== 0) throw new HttpError(502, machine.type === 'ssh' ? tk('Falha ao enviar o arquivo via SSH') : tk('Falha ao gravar o arquivo'));
  const path = r.stdout.trim().split('\n').pop() ?? '';
  if (!path.startsWith('/')) throw new HttpError(502, 'Resposta inesperada da máquina');
  return { path, name, bytes: data.length, mime };
}
