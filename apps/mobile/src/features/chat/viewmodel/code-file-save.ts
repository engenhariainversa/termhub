import { Platform, Share } from 'react-native';
import { codeFileMime } from '../model/code-file';

/**
 * Saves a chat code block as a file (TER-1084), the phone's way, with no new native module:
 *  - iOS: the file is written to the app's cache and handed to the share sheet as a file, which offers
 *    "Salvar em Arquivos" and every app that opens text;
 *  - Android: the system folder picker (Storage Access Framework), and the file is created there.
 *    React Native's share sheet only shares text on Android, so it is the fallback when the picker is
 *    not available or fails — the content then goes out as text, never lost.
 * A picker the person cancels saves nothing and says nothing. Resolves to whether the content left the app.
 */
export async function saveCodeFile(name: string, content: string, ext: string): Promise<boolean> {
  // Loaded on demand, like `audio-cache.ts`: the native module is not there under Jest.
  const { Directory, File, Paths } = await import('expo-file-system');
  if (Platform.OS === 'ios') {
    const file = new File(Paths.cache, name);
    file.create({ overwrite: true });
    file.write(content);
    const result = await Share.share({ url: file.uri, title: name });
    return result.action === Share.sharedAction;
  }
  let dir: InstanceType<typeof Directory>;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch (error) {
    // Cancelled: the person chose not to save.
    if (/cancel/i.test(String((error as Error)?.message ?? error))) return false;
    return shareAsText(name, content);
  }
  try {
    const file = dir.createFile(name, codeFileMime(ext));
    file.write(content);
    return true;
  } catch {
    return shareAsText(name, content);
  }
}

async function shareAsText(name: string, content: string): Promise<boolean> {
  const result = await Share.share({ title: name, message: content });
  return result.action === Share.sharedAction;
}
