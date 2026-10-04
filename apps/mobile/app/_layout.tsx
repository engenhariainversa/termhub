import '../global.css';
import { Stack, useRouter, useSegments, type Href } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PushPrimerSheet } from '@/features/permissions/view/push-primer-sheet';
import { setSystemSettingsOpener } from '@/features/permissions/viewmodel/usePermissionsStore';
import { useNotificationsStore } from '@/features/notifications/viewmodel/useNotificationsStore';
import { PinPromptSheet } from '@/features/session/view/pin-prompt-sheet';
import { usePhaseRedirect } from '@/features/session/view/use-phase-redirect';
import { useSessionStore } from '@/features/session/viewmodel/useSessionStore';
import { appBackgrounded } from '@/features/shared/signals';
import { logScreen } from '@/services/analytics';
import { configurePush, pushConversationId, pushNotificationId } from '@/services/push';
import { socketWake } from '@/services/api/wake';
import { ThemeProvider, useSchemeName } from '@/ui/theme-provider';

// Viewmodels never import react-native: the permissions store opens the system settings through this.
setSystemSettingsOpener(() => Linking.openSettings());

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

configurePush();

/**
 * Route groups follow the flow of spec §11.2: enrolment (Início → Aguardando aprovação → Criar PIN),
 * Desbloquear, then the tabs. `usePhaseRedirect` (design spec §8) keeps the visible route in step
 * with the session phase; a deep link caught while not `unlocked` is stashed as `pendingRoute` and
 * followed once the session unlocks (P§9).
 */
function Navigator() {
  const scheme = useSchemeName();
  const router = useRouter();
  const segments = useSegments();
  usePhaseRedirect();

  // The route pattern (`/chat/[id]`), never the resolved path: ids stay out of analytics.
  const route = `/${segments.join('/')}`;
  useEffect(() => {
    logScreen(route);
  }, [route]);

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

  const openChat = useCallback(
    (id: string) => {
      // Already unlocked: navigate at once, no need to stash and wait for `usePhaseRedirect`.
      if (useSessionStore.getState().phase === 'unlocked') router.push(`/chat/${id}` as Href);
      else useSessionStore.getState().setPendingRoute(`/chat/${id}`);
    },
    [router],
  );

  useEffect(() => {
    const handle = (url: string) => {
      const id = chatIdFromUrl(url);
      if (id) openChat(id);
    };
    Linking.getInitialURL()
      .then((url) => {
        if (url) handle(url);
      })
      .catch(() => undefined);
    const sub = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => sub.remove();
  }, [openChat]);

  // A tapped push — on a cold start too — opens its conversation, after the PIN when locked, and
  // marks its history row read (P§9). Cleared once followed, so a remount never opens it again.
  const tapped = Notifications.useLastNotificationResponse();
  const [readOnUnlock, setReadOnUnlock] = useState<string | null>(null);
  useEffect(() => {
    if (!tapped || tapped.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    Notifications.clearLastNotificationResponse();
    const { data } = tapped.notification.request.content;
    setReadOnUnlock(pushNotificationId(data));
    const id = pushConversationId(data);
    if (id) openChat(id);
  }, [tapped, openChat]);

  // Marking read needs a session: a push tapped while locked waits for the PIN.
  const phase = useSessionStore((s) => s.phase);
  useEffect(() => {
    if (!readOnUnlock || phase !== 'unlocked') return;
    setReadOnUnlock(null);
    void useNotificationsStore.getState().markPushRead(readOnUnlock);
  }, [readOnUnlock, phase]);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }}>
        {/* The thread's rows answer a drag to the right (TER-447). Left unset, iOS 26 also pops the
            screen on a right drag from anywhere in it, so a drag that missed a row's own recognizer
            left the chat (TER-849). Back stays on the screen's edge, as before iOS 26. */}
        <Stack.Screen name="chat/[id]" options={{ fullScreenGestureEnabled: false }} />
      </Stack>
      <PinPromptSheet />
      <PushPrimerSheet />
    </>
  );
}

// The gesture handler's root: the chat's drag-to-answer (TER-447) needs it above every screen.
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <Navigator />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
