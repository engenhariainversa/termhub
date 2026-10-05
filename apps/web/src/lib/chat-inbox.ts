import { useEffect, useRef } from 'react';

/**
 * Files handed to a chat's composer from elsewhere ("Mandar para o chat" on a file preview, spec
 * 2026-10-04 file preview D16). They wait here, per chat (a project id, or '' for the account chat),
 * until that chat's composer is mounted and takes them as attachments. Nothing is sent: the person does.
 */
const queues = new Map<string, File[]>();
const listeners = new Set<(key: string) => void>();
const keyOf = (projectId: string | null) => projectId ?? '';

export function sendFileToChat(projectId: string | null, file: File): void {
  const key = keyOf(projectId);
  queues.set(key, [...(queues.get(key) ?? []), file]);
  for (const l of listeners) l(key);
}

/** Takes the files waiting for this chat now and whenever more arrive. */
export function useChatInbox(projectId: string | null, take: (files: File[]) => void): void {
  const takeRef = useRef(take);
  takeRef.current = take;
  useEffect(() => {
    const key = keyOf(projectId);
    const drain = (k: string) => {
      if (k !== key) return;
      const files = queues.get(key);
      if (!files?.length) return;
      queues.delete(key);
      takeRef.current(files);
    };
    listeners.add(drain);
    drain(key);
    return () => {
      listeners.delete(drain);
    };
  }, [projectId]);
}
