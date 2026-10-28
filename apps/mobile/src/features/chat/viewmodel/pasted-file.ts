import { pastedTextName, utf8Bytes } from '@termhub/mobile-api';
import type { PickedFile } from './attachments';

/**
 * A long text as the `.txt` the composer sends it as (TER-1139): written to the app's cache, since an
 * upload reads a file URI, and handed over as a picked file named `colado-AAAA-MM-DD-HHMM.txt`.
 */
export async function pastedTextFile(text: string): Promise<PickedFile> {
  // Loaded on demand, like `chat-inbox.ts`: the native module is not there under Jest.
  const { File, Paths } = await import('expo-file-system');
  const name = pastedTextName();
  const file = new File(Paths.cache, `paste-${Date.now()}-${name}`);
  file.create({ overwrite: true });
  file.write(text);
  return { uri: file.uri, name, mime: 'text/plain', bytes: utf8Bytes(text) };
}
