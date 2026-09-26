import '../global.css';
import { Stack, useRouter, type Href } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Linking } from 'react-native';
import { PinPromptSheet } from '@/features/session/view/pin-prompt-sheet';
import { usePhaseRedirect } from '@/features/session/view/use-phase-redirect';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { appBackgrounded } from '@/features/shared/signals';
import { socketWake } from '@/services/api/wake';
import { ThemeProvider, useSchemeName } from '@/ui/theme-provider';

/** `'termhub://chat/<id>'` or `'https://termhub.dev/chat/<id>'` → the chat id, or `null`. */
function chatIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const parts = `${parsed.host}${parsed.pathname}`.split('/').filter(Boolean);
  const i = parts.indexOf('chat');
  return i >= 0 ? (parts[i + 1] ?? null) : null;
}

/**
 * Route groups follow the flow of spec §11.2: enrolment (Início → Aguardando aprovação → Criar PIN),
 * Desbloquear, then the tabs. `usePhaseRedirect` (design spec §8) keeps the visible route in step
 * with the session phase; a deep link caught while not `unlocked` is stashed as `pendingRoute` and
 * followed once the session unlocks (P§9).
 */
function Navigator() {
  const scheme = useSchemeName();
  const router = useRouter();
  usePhaseRedirect();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const session = useSessionStore.getState();
      if (next === 'background' || next === 'inactive') {
        session.background();
        // A chat mid-answer has writes on a throttle: they land now, not after the OS suspends us.
        appBackgrounded.emit();
      } else if (next === 'active') {
        session.foreground();
        // A chat socket that backed off while the app was away reconnects now (P§6.1).
        socketWake.emit();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const handle = (url: string) => {
      const id = chatIdFromUrl(url);
      if (!id) return;
      // Already unlocked: navigate at once, no need to stash and wait for `usePhaseRedirect`.
      if (useSessionStore.getState().phase === 'unlocked') router.push(`/chat/${id}` as Href);
      else useSessionStore.getState().setPendingRoute(`/chat/${id}`);
    };
    Linking.getInitialURL()
      .then((url) => {
        if (url) handle(url);
      })
      .catch(() => undefined);
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, [router]);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />
      <PinPromptSheet />
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <Navigator />
    </ThemeProvider>
  );
}
