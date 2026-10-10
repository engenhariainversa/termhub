import { open, rename, rm } from 'node:fs/promises';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { ExportRows, UserDataBundle } from '../db/repositories/data-exports.js';
import { t, type Locale } from '../i18n/index.js';

export interface ArchiveEntry {
  /** Path inside the zip, always with `/`. */
  name: string;
  data: Uint8Array;
  /** false for files that are compressed already (images, audio, video, office files). */
  deflate: boolean;
}

/**
 * Writes the entries to `file` as a zip, one entry in memory at a time, through a temporary name
 * renamed at the end (a reader never sees half a file). Returns the size in bytes. No zip64: an
 * account's attachments are capped well under 4 GB by the chat-files quota.
 */
export async function writeZip(file: string, entries: AsyncIterable<ArchiveEntry>): Promise<number> {
  const temp = `${file}.tmp`;
  const fh = await open(temp, 'w');
  let bytes = 0;
  try {
    const chunks: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) failure = err;
      else chunks.push(chunk);
    });
    const flush = async () => {
      if (failure) throw failure;
      while (chunks.length) {
        const chunk = chunks.shift()!;
        await fh.write(chunk);
        bytes += chunk.length;
      }
    };
    for await (const entry of entries) {
      const item = entry.deflate ? new ZipDeflate(entry.name, { level: 6 }) : new ZipPassThrough(entry.name);
      zip.add(item);
      item.push(entry.data, true);
      await flush();
    }
    zip.end();
    await flush();
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(temp, { force: true });
    throw err;
  }
  await fh.close();
  await rename(temp, file);
  return bytes;
}

const json = (value: unknown): ArchiveEntry['data'] => strToU8(JSON.stringify(value, null, 2) + '\n');

/** A name safe in any file system, keeping what the person would recognise. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s]+/, '').trim();
  return (cleaned || 'file').slice(0, 120);
}

/** Kinds of attachment stored compressed already: zipping them again only costs time. */
const STORED_KINDS = new Set(['image', 'audio', 'video', 'docx', 'xlsx', 'pdf']);

/** Where each table goes inside the zip (the README lists them). */
const LAYOUT: [keyof Omit<UserDataBundle, 'account'>, string][] = [
  ['projects', 'projects/projects.json'],
  ['project_machines', 'projects/machines.json'],
  ['project_setups', 'projects/setups.json'],
  ['project_groups', 'projects/groups.json'],
  ['columns', 'projects/columns.json'],
  ['cards', 'projects/cards.json'],
  ['pull_requests', 'projects/pull-requests.json'],
  ['notes', 'projects/notes.json'],
  ['tickets', 'projects/tickets.json'],
  ['tabs', 'tabs/tabs.json'],
  ['last_answers', 'tabs/last-answers.json'],
  ['tab_questions', 'tabs/questions.json'],
  ['conversations', 'chat/conversations.json'],
  ['messages', 'chat/messages.json'],
  ['actions', 'chat/actions.json'],
  ['decisions', 'chat/decisions.json'],
  ['memory', 'memory/memory.json'],
  ['machines', 'machines/machines.json'],
  ['ai_accounts', 'machines/ai-accounts.json'],
  ['uploads', 'machines/uploads.json'],
  ['integrations', 'integrations/integrations.json'],
  ['api_tokens', 'integrations/api-tokens.json'],
  ['devices', 'devices/devices.json'],
  ['device_events', 'devices/events.json'],
  ['notifications', 'devices/notifications.json'],
];

function readme(locale: Locale, generatedAt: Date): string {
  return [
    t(locale, 'Exportação dos seus dados do termhub'),
    t(locale, 'Gerada em {{date}} (UTC).', { date: generatedAt.toISOString() }),
    '',
    t(locale, 'Cada arquivo .json traz uma lista de registros, com datas em ISO 8601 (UTC) e ids que ligam um arquivo ao outro (project_id, conversation_id, machine_id…).'),
    t(locale, 'account.json: sua conta. projects/: projetos, colunas, cards, notas (também em notes/*.md) e tickets. tabs/: abas, últimas respostas dos agentes e perguntas das abas. chat/: conversas, mensagens, ações, decisões e anexos. memory/: a memória do chat. machines/: máquinas, contas de IA e arquivos enviados aos terminais. integrations/: integrações e tokens de API. devices/: aparelhos, histórico deles e notificações.'),
    t(locale, 'Senhas, tokens, chaves e segredos das integrações não entram no arquivo.'),
    '',
  ].join('\n');
}

/**
 * The archive's entries for one account: a README, account.json, one JSON per table, each project's
 * note as Markdown and the chat attachments' bytes. `attachments.json` says where each file landed,
 * or `file: null` when its bytes are gone from the volume.
 */
export async function* exportEntries(
  bundle: UserDataBundle,
  opts: { locale: Locale; generatedAt: Date; readAttachment: (id: string) => Promise<Uint8Array | null> },
): AsyncGenerator<ArchiveEntry> {
  yield { name: 'README.txt', data: strToU8(readme(opts.locale, opts.generatedAt)), deflate: true };
  yield { name: 'account.json', data: json(bundle.account), deflate: true };
  for (const [key, name] of LAYOUT) yield { name, data: json(bundle[key]), deflate: true };

  const keyOf = new Map(bundle.projects.map((p) => [p.id as string, String(p.key)]));
  for (const note of bundle.notes) {
    const key = keyOf.get(note.project_id as string) ?? String(note.project_id);
    yield { name: `projects/notes/${safeFileName(key)}.md`, data: strToU8(String(note.content ?? '')), deflate: true };
  }

  const listed: ExportRows = [];
  const taken = new Set<string>();
  for (const a of bundle.attachments) {
    const data = await opts.readAttachment(String(a.id));
    let file: string | null = null;
    if (data) {
      file = `chat/attachments/${String(a.id)}-${safeFileName(String(a.name))}`;
      if (!taken.has(file)) {
        taken.add(file);
        yield { name: file, data, deflate: !STORED_KINDS.has(String(a.kind)) };
      }
    }
    listed.push({ ...a, file });
  }
  yield { name: 'chat/attachments.json', data: json(listed), deflate: true };
}
