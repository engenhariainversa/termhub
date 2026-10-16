import { createHash } from 'node:crypto';
import path from 'node:path';
import { FILE_SHARE_CHUNK_BYTES, FILE_SHARE_EXTENSIONS, FILE_SHARE_MAX_BYTES, type FileShareRefusal, type RpcParams, type RpcResult } from '@termhub/agent-protocol';
import { ATTACHMENT_LIMITS, type ChatAttachment } from '@termhub/mobile-api';
import { isSecretPath } from '@termhub/machine-ops';
import { agentRpc, requireFileShareCapable } from '../../agent/errors.js';
import { recordSecurityEvent } from '../../auth/audit.js';
import { ControlError, type ControlContext } from '../../control/context.js';
import { toPublicAttachment } from '../../db/repositories/chat-attachments.js';
import type { ChatConversation, ChatMessage } from '../../db/repositories/chat.js';
import type { Machine } from '../../db/repositories/types.js';
import { localeOf, msg, t, tk } from '../../i18n/index.js';
import { newId } from '../../lib/ids.js';
import { chatBus } from '../bus.js';
import type { ExtractionQueue } from './queue.js';
import { sniff } from './sniff.js';
import { sanitiseFileName } from './upload.js';

/** What `share_file` needs besides the context: where the bytes go and the person's attachment quota. */
export interface ShareDeps {
  queue: Pick<ExtractionQueue, 'enqueue'>;
  quotaBytes: number;
}

/** Per person, per rolling 24 h (TER-1086): a brake on what a prompt injected into a screen could carry out. */
export const SHARE_DAILY_LIMIT = { files: 100, bytes: 500 * 1024 * 1024 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SHARE_CAPTION_MAX = 500;
/** `meta.source` of a row `share_file` created: counted against the daily limit, never swept as unsent. */
export const SHARED_SOURCE = 'machine';

export interface ShareArgs {
  machine_id?: string;
  path: string;
  caption?: string;
}

export interface ShareResult {
  attachment: ChatAttachment;
  message_id: string;
  conversation_id: string;
  note: string;
}

/**
 * What the path argument must look like before anything is asked or proposed: absolute or `~/`, a kind the
 * chat shows, and never a secret. A refused path never becomes a confirmation card. Pure; returns the
 * reason in pt-BR, or null.
 */
export function pathRefusal(p: string): string | null {
  if (!(p.startsWith('/') || p.startsWith('~/')) || /[\0\n\r]/.test(p)) return tk('Informe o caminho absoluto do arquivo (pode começar com ~/)');
  if (isSecretPath(p)) return tk('Este caminho não pode ser compartilhado: chaves, credenciais, arquivos .env e pastas de configuração ficam na máquina');
  if (!(FILE_SHARE_EXTENSIONS as readonly string[]).includes(path.posix.extname(p).toLowerCase())) return tk('Tipo de arquivo não compartilhável: só imagens (png, jpg, gif, webp), PDF, Word, Excel, áudio, vídeo e texto');
  return null;
}

const REFUSAL_TEXT: Record<FileShareRefusal, string> = {
  missing: tk('O arquivo não existe na máquina'),
  outside: tk('O arquivo está fora das pastas que podem ser compartilhadas'),
  hidden: tk('O arquivo está numa pasta oculta (começa com ponto) e não pode ser compartilhado'),
  secret: tk('Este caminho não pode ser compartilhado: chaves, credenciais, arquivos .env e pastas de configuração ficam na máquina'),
  type: tk('Tipo de arquivo não compartilhável: só imagens (png, jpg, gif, webp), PDF, Word, Excel, áudio, vídeo e texto'),
  not_file: tk('O caminho não é um arquivo'),
  too_large: tk('Arquivo grande demais para compartilhar'),
  eperm: tk('O agente não tem permissão para ler este arquivo'),
  changed: tk('O arquivo mudou enquanto era lido; tente de novo'),
};

const CODE: Record<FileShareRefusal, string> = {
  missing: 'FILE_NOT_FOUND',
  outside: 'FILE_BLOCKED',
  hidden: 'FILE_BLOCKED',
  secret: 'FILE_BLOCKED',
  type: 'FILE_TYPE',
  not_file: 'FILE_NOT_FOUND',
  too_large: 'FILE_TOO_LARGE',
  eperm: 'FILE_EPERM',
  changed: 'FILE_CHANGED',
};

const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`;

export type ShareRpc = (machine: Machine, params: RpcParams<'file.share'>) => Promise<RpcResult<'file.share'>>;
const defaultRpc: ShareRpc = (machine, params) => agentRpc(machine, 'file.share', params);

/** Every chunk of the file, asked in order; a size or date that moves between two chunks is refused. */
export async function fetchFile(rpc: ShareRpc, machine: Machine, params: { path: string; roots: string[]; only_roots: boolean }): Promise<{ path: string; body: Buffer }> {
  const parts: Buffer[] = [];
  let offset = 0;
  let first: { size: number; mtime_ms: number; path: string } | null = null;
  do {
    const r = await rpc(machine, { ...params, offset, length: FILE_SHARE_CHUNK_BYTES });
    if (r.status !== 'ok') {
      if (r.status === 'too_large') throw new ControlError(CODE.too_large, msg('Arquivo grande demais para compartilhar (limite de {{size}})', { size: mb(FILE_SHARE_MAX_BYTES) }));
      throw new ControlError(CODE[r.status], msg(REFUSAL_TEXT[r.status]));
    }
    if (first && (r.size !== first.size || r.mtime_ms !== first.mtime_ms || r.path !== first.path)) throw new ControlError(CODE.changed, msg(REFUSAL_TEXT.changed));
    first ??= { size: r.size, mtime_ms: r.mtime_ms, path: r.path };
    const chunk = Buffer.from(r.content_b64, 'base64');
    // An empty chunk before the end would ask the same offset for ever.
    if (chunk.length === 0 && offset < r.size) throw new ControlError(CODE.changed, msg(REFUSAL_TEXT.changed));
    parts.push(chunk);
    offset += chunk.length;
  } while (offset < first.size);
  return { path: first.path, body: Buffer.concat(parts, offset) };
}

/** The conversation the file goes to: the concierge's own, else the tab's project chat, else the person's general chat. */
async function conversationFor(ctx: ControlContext): Promise<ChatConversation> {
  const userId = ctx.scope.user.id;
  const own = ctx.token?.chat_conversation_id ? await ctx.repos.chat.findByIdForUser(ctx.token.chat_conversation_id, userId) : undefined;
  if (own && !own.archived_at) return own;
  const projectId = ctx.token?.tab?.project_id ?? own?.project_id ?? null;
  if (projectId) return (await ctx.repos.chat.findLatestActiveForProject(projectId, userId)) ?? (await ctx.repos.chat.getOrCreateForProject(userId, projectId));
  return ctx.repos.chat.getOrCreateForUser(userId);
}

/** The machine and the folders it may share from: an agent tab only from its own folder on its own machine. */
async function sourceFor(ctx: ControlContext, args: ShareArgs): Promise<{ machine: Machine; roots: string[]; only_roots: boolean }> {
  const tab = ctx.token?.tab;
  if (tab) {
    const { machine, cwd } = await ctx.scoped.tab(tab.id);
    if (args.machine_id && args.machine_id !== machine.id) throw new ControlError('FILE_BLOCKED', 'Uma aba de agente só compartilha arquivos da própria máquina');
    return { machine, roots: [cwd], only_roots: true };
  }
  if (!args.machine_id) throw new ControlError('INVALID_ARGS', 'Informe machine_id');
  return { machine: await ctx.scoped.machine(args.machine_id), roots: [], only_roots: false };
}

/**
 * `share_file` (TER-1086): a file of one of the person's machines, published in the conversation as an
 * attachment of a message of the assistant, with preview and download on every screen. Same storage,
 * quota and kind rules as an upload (the bytes decide the kind, never the name); on top of them, a 25 MB
 * cap, a daily brake, the secret paths and a security-trail row (who, machine, path, size). On the
 * concierge's token it only runs once the person approved it (or a "Permitir sempre nesta pasta" grant
 * covers it: the gate decides, before this runs). Logs metadata only.
 */
export async function shareFile(ctx: ControlContext, deps: ShareDeps | undefined, args: ShareArgs, rpc: ShareRpc = defaultRpc): Promise<ShareResult> {
  if (!ctx.attachments || !deps) throw new ControlError('ATTACHMENTS_UNAVAILABLE', 'Anexos não estão disponíveis neste servidor');
  const refusal = pathRefusal(args.path);
  if (refusal) throw new ControlError(refusal === REFUSAL_TEXT.type ? 'FILE_TYPE' : 'FILE_BLOCKED', msg(refusal));
  const user = ctx.scope.user;
  const { machine, roots, only_roots } = await sourceFor(ctx, args);
  requireFileShareCapable(machine);

  const since = new Date(Date.now() - DAY_MS);
  const used = await ctx.repos.chatAttachments.sharedSince(user.id, since);
  if (used.files >= SHARE_DAILY_LIMIT.files || used.bytes >= SHARE_DAILY_LIMIT.bytes) {
    throw new ControlError('FILE_SHARE_LIMIT', msg('Limite diário de arquivos compartilhados atingido ({{files}} arquivos ou {{size}} em 24 h)', { files: SHARE_DAILY_LIMIT.files, size: mb(SHARE_DAILY_LIMIT.bytes) }));
  }

  const { path: real, body } = await fetchFile(rpc, machine, { path: args.path, roots, only_roots });
  if (body.length === 0) throw new ControlError('FILE_EMPTY', 'Arquivo vazio');
  const name = sanitiseFileName(path.posix.basename(real));
  const sniffed = sniff(body, name);
  if (sniffed === null || 'refused' in sniffed) throw new ControlError('FILE_TYPE', msg(REFUSAL_TEXT.type));
  const limit = Math.min(ATTACHMENT_LIMITS[sniffed.kind], FILE_SHARE_MAX_BYTES);
  if (body.length > limit) throw new ControlError('FILE_TOO_LARGE', msg('Arquivo grande demais para compartilhar (limite de {{size}})', { size: mb(limit) }));
  if (used.bytes + body.length > SHARE_DAILY_LIMIT.bytes) {
    throw new ControlError('FILE_SHARE_LIMIT', msg('Limite diário de arquivos compartilhados atingido ({{files}} arquivos ou {{size}} em 24 h)', { files: SHARE_DAILY_LIMIT.files, size: mb(SHARE_DAILY_LIMIT.bytes) }));
  }
  if ((await ctx.repos.chatAttachments.usageBytes(user.id)) + body.length > deps.quotaBytes) {
    throw new ControlError('ATTACHMENT_QUOTA', msg('Espaço de anexos esgotado (limite de {{size}})', { size: mb(deps.quotaBytes) }));
  }

  const conversation = await conversationFor(ctx);
  const id = newId();
  await ctx.attachments.write(user.id, id, body);
  let message: ChatMessage | undefined;
  try {
    const sha256 = createHash('sha256').update(body).digest('hex');
    await ctx.repos.chatAttachments.create({ id, user_id: user.id, conversation_id: conversation.id, name, mime: sniffed.mime, kind: sniffed.kind, bytes: body.length, sha256, meta: { source: SHARED_SOURCE, machine_id: machine.id } });
    const caption = args.caption?.trim();
    // Never an empty answer: a screen reads an assistant row with no text as a run that failed.
    const text = caption || t(localeOf(user.locale), 'Arquivo de {{machine}}: {{name}}', { machine: machine.name, name });
    message = await ctx.repos.chat.addMessage({ conversation_id: conversation.id, role: 'assistant', text });
    await ctx.repos.chatAttachments.attach([id], message.id, user.id, conversation.id);
  } catch (err) {
    // No message, no file: the row (if any) goes with its file, the sweep does not have to find it.
    if (message) await ctx.repos.chat.deleteMessage(message.id).catch(() => undefined);
    await ctx.repos.chatAttachments.deleteUnsent(id, user.id).catch(() => undefined);
    await ctx.attachments.remove(user.id, id).catch(() => undefined);
    throw err;
  }
  deps.queue.enqueue(id);

  const row = await ctx.repos.chatAttachments.findForUser(id, user.id);
  const attachment = toPublicAttachment(row!);
  chatBus.publish({ type: 'message', user_id: user.id, conversation_id: conversation.id, message: { ...message, attachments: [attachment] } });
  ctx.log?.info({ attachmentId: id, conversationId: conversation.id, machine_id: machine.id, kind: sniffed.kind, bytes: body.length }, 'chat file shared');
  await recordSecurityEvent(ctx.repos, {
    actor_id: user.id,
    actor_email: user.email,
    action: 'machine.file_share',
    target_type: 'machine',
    target_id: machine.id,
    target_label: machine.name,
    meta: { path: real, bytes: body.length, kind: sniffed.kind, attachment_id: id, conversation_id: conversation.id, via: ctx.token?.tab ? 'tab' : ctx.token?.gated ? 'concierge' : 'mcp', ...(ctx.token?.tab ? { tab_id: ctx.token.tab.id } : {}) },
  });
  return {
    attachment,
    message_id: message.id,
    conversation_id: conversation.id,
    note: t(localeOf(user.locale), 'O arquivo foi publicado na conversa, com prévia e botão de download. Não repita o envio; se quiser, comente o arquivo na resposta.'),
  };
}
