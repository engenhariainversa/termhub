// The running update, from `expo-updates` (TER-913). Kept here so views never import the native module.
import * as Updates from 'expo-updates';

export const runningUpdate = (): { updateId: string | null; isEmbeddedLaunch: boolean } => ({ updateId: Updates.updateId ?? null, isEmbeddedLaunch: Updates.isEmbeddedLaunch });
