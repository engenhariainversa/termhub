import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, Sheet } from '@/ui';
import { PAUSE_MSG, pausedBanner, pausedSince } from '../model/pause';
import { pauseControlsVisible } from '../viewmodel/createPauseStore';
import { usePauseStore } from '../viewmodel/usePauseStore';

/**
 * "Pausar tudo" (TER-942): the same switch as the web's, in Ajustes and in Progresso. While paused it says
 * since when; pausing never asks for the PIN, resuming asks to confirm (a sheet, not the PIN). Reads the
 * state while the screen is focused.
 */
export function PauseCard({ testID = 'pause-card', loadingText }: { testID?: string; loadingText?: string }) {
  const state = usePauseStore((s) => s.state);
  const unavailable = usePauseStore((s) => s.unavailable);
  const busy = usePauseStore((s) => s.busy);
  const error = usePauseStore((s) => s.error);
  const [confirming, setConfirming] = useState(false);
  useFocusEffect(
    useCallback(() => {
      usePauseStore.getState().startPolling();
      return () => usePauseStore.getState().stopPolling();
    }, []),
  );
  if (state === null) return loadingText && !unavailable ? <AppText variant="muted">{loadingText}</AppText> : null;
  if (!pauseControlsVisible(state)) return null;
  const since = pausedSince(state);
  return (
    <View testID={testID} className="gap-3">
      {since ? <AppText className="font-semibold">{pausedBanner(since)}</AppText> : null}
      {since ? (
        <Button label={PAUSE_MSG.resume} variant="secondary" disabled={busy} onPress={() => setConfirming(true)} />
      ) : (
        <>
          <Button label={PAUSE_MSG.pause} variant="secondary" disabled={busy} onPress={() => void usePauseStore.getState().pauseAll()} />
          <Button label={PAUSE_MSG.pauseAndInterrupt} variant="ghost" disabled={busy} onPress={() => void usePauseStore.getState().pauseAll(true)} />
        </>
      )}
      {error ? <AppText className="text-red-400">{error}</AppText> : null}
      <Sheet open={confirming} onClose={() => setConfirming(false)} title={PAUSE_MSG.resumeTitle}>
        <View className="gap-4">
          <AppText>{PAUSE_MSG.resumeBody}</AppText>
          <Button
            label={PAUSE_MSG.resumeConfirm}
            onPress={() => {
              setConfirming(false);
              void usePauseStore.getState().resumeAll();
            }}
          />
          <Button label={PAUSE_MSG.cancel} variant="ghost" onPress={() => setConfirming(false)} />
        </View>
      </Sheet>
    </View>
  );
}
