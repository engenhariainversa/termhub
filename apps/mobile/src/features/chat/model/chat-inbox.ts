// Files handed to a chat's composer from elsewhere ("Mandar para o chat" on a file preview, spec
// 2026-10-04 file preview D16). They wait here per chat (a project id, or '' for the general chat) until
// that chat's composer takes them as attachment chips. Nothing is sent: the person does.
import type { PickedFile } from '../viewmodel/attachments';

const queues = new Map<string, PickedFile[]>();
const listeners = new Set<(key: string) => void>();
export const inboxKey = (projectId: string | null) => projectId ?? '';

export function queueChatFile(projectId: string | null, file: PickedFile): void {
  const key = inboxKey(projectId);
  queues.set(key, [...(queues.get(key) ?? []), file]);
  for (const l of listeners) l(key);
}

/** The files waiting for `key`, taken: the caller adds them as chips. */
export function takeChatFiles(key: string): PickedFile[] {
  const files = queues.get(key) ?? [];
  queues.delete(key);
  return files;
}

export function onChatFiles(listener: (key: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes `content` to a cache file (the upload reads a file URI) and queues it for the chat. */
export async function sendFileToChat(projectId: string | null, name: string, content: string): Promise<void> {
  // Loaded on demand, like `transport.ts`: the native module is not there under Jest.
  const { File, Paths } = await import('expo-file-system');
  const safe = name.replace(/[^\p{L}\p{N}._-]/gu, '_') || 'arquivo.md';
  const file = new File(Paths.cache, `preview-${Date.now()}-${safe}`);
  file.create({ overwrite: true });
  file.write(content);
  queueChatFile(projectId, { uri: file.uri, name, mime: 'text/markdown', bytes: new TextEncoder().encode(content).length });
}
