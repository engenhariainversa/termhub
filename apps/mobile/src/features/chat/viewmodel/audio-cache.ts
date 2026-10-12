import type { TChatAttachment } from '@/services/api/contract';

type Source = { uri: string; headers: Record<string, string> };

/**
 * A sent audio attachment as a file in the app's cache, for the bubble's player (TER-1036). The
 * download is one signed request: a DPoP proof is single-use, and a player streaming the URL itself
 * would ask again for each range it buffers. A clip already in the cache is not fetched again.
 */
export async function cachedAudio(a: Pick<TChatAttachment, 'id' | 'name'>, sign: (id: string) => Promise<Source>): Promise<string> {
  // Loaded on demand, like the transport's upload: `expo-file-system` reaches its native module at
  // import time, and the bubble is rendered by tests where none exists.
  const { File, Paths } = await import('expo-file-system');
  const ext = /\.[a-z0-9]{1,5}$/i.exec(a.name)?.[0] ?? '.m4a';
  const file = new File(Paths.cache, `chat-audio-${a.id}${ext}`);
  if (file.exists) return file.uri;
  const source = await sign(a.id);
  const done = await File.downloadFileAsync(source.uri, file, { headers: source.headers });
  return done.uri;
}
