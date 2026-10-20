// The app's one focus reporter (TER-642), started by `app/_layout.tsx` at boot: "in focus" is the app
// in the foreground. The id is random per app launch, so two phones of one person count apart.
import { AppState } from 'react-native';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { api } from '@/services/api';
import { randomId } from '@/services/crypto/random';
import { createFocusReporter } from '../viewmodel/createFocusReporter';

export const focusReporter = createFocusReporter({
  api,
  session: () => useSessionStore.getState(),
  clientId: randomId(),
  active: () => AppState.currentState === 'active',
});
