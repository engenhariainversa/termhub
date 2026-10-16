import { Platform, Share } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';

type Source = { uri: string; headers: Record<string, string> };

/**
 * Saves a chat attachment on the phone (TER-1086), with no new native module, the way `saveCodeFile`
 * (TER-1084) saves a code block:
 *  - the file is downloaded once into the app's cache, under its own name (one signed request: a DPoP
 *    proof is single-use);
 *  - iOS: the share sheet gets the file, which offers "Salvar imagem" (the photo library) for an image,
 *    "Salvar em Arquivos" for any kind, and every app that opens it;
 *  - Android: the system folder picker (Storage Access Framework) and the file is written there; an
 *    image saved in Pictures or DCIM shows in the gallery. React Native's share sheet only shares text
 *    on Android, so there is no fallback: a failure is reported to the caller.
 * A picker or sheet the person cancels saves nothing. Resolves to whether the file left the app.
 */
export async function saveAttachment(a: Pick<TChatAttachment, 'id' | 'name' | 'mime'>, sign: (id: string) => Promise<Source>): Promise<boolean> {
  // Loaded on demand, like `audio-cache.ts`: the native module is not there under Jest.
  const { Directory, File, Paths } = await import('expo-file-system');
  const dir = new Directory(Paths.cache, 'chat-files', a.id);
  dir.create({ intermediates: true, idempotent: true });
  let file = new File(dir, a.name);
  if (!file.exists) {
    const source = await sign(a.id);
    file = await File.downloadFileAsync(source.uri, file, { headers: source.headers });
  }
  if (Platform.OS === 'ios') {
    const result = await Share.share({ url: file.uri, title: a.name });
    return result.action === Share.sharedAction;
  }
  let target: InstanceType<typeof Directory>;
  try {
    target = await Directory.pickDirectoryAsync();
  } catch (error) {
    // Cancelled: the person chose not to save.
    if (/cancel/i.test(String((error as Error)?.message ?? error))) return false;
    throw error;
  }
  const out = target.createFile(a.name, a.mime.split(';')[0]!.trim());
  out.write(await file.bytes());
  return true;
}
