// The system clipboard, where the binary has one (TER-1090). React Native 0.86 ships no clipboard, and
// `expo-clipboard` is a native module: adding it is a store build (TER-994). Until a binary carries it,
// this file looks it up at run time and says it is missing, so the bundle that uses it still ships over
// the air and lights up on its own once a build with the module is installed.
import { requireOptionalNativeModule } from 'expo';

type ClipboardModule = { setStringAsync(text: string, options: Record<string, unknown>): Promise<boolean | void> };

let cached: ClipboardModule | null | undefined;

function nativeClipboard(): ClipboardModule | null {
  if (cached === undefined) {
    try {
      cached = requireOptionalNativeModule<ClipboardModule>('ExpoClipboard');
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Whether this binary can put text on the clipboard. */
export function canCopy(): boolean {
  return nativeClipboard() !== null;
}

/** Puts `text` on the clipboard; resolves to whether it did. Never rejects. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = nativeClipboard();
  if (!clipboard) return false;
  try {
    await clipboard.setStringAsync(text, {});
    return true;
  } catch {
    return false;
  }
}
