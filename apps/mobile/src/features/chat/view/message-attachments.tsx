import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { memo, useEffect, useReducer, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, Text, View } from 'react-native';
import type { TChatAttachment } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { Icon } from '@/ui';
import { ApiError } from '@/services/api/errors';
import { attachmentStatusText, canRetryAttachment, formatBytes, thumbSize } from '../viewmodel/attachments';
import { cachedAudio } from '../viewmodel/audio-cache';
import { useChatStore } from '../viewmodel/useChatStore';
import { ATTACHMENT_ICON, KIND_ICON } from './attachment-chip';

type Source = { uri: string; headers: Record<string, string> };

/** The signed `<Image source>` for a sent image: the store signs one DPoP proof per `attempt`, with the
 * token it holds then. `null` while a proof is being signed. A source is tied to the attempt it was
 * signed for and read during render, so a new attempt never mounts the previous, already used proof. */
export function useAttachmentSource(id: string, attempt: number): Source | null {
  const attachmentSource = useChatStore((s) => s.attachmentSource);
  const [signed, setSigned] = useState<{ id: string; attempt: number; source: Source } | null>(null);
  useEffect(() => {
    let live = true;
    attachmentSource(id)
      .then((source) => live && setSigned({ id, attempt, source }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [attachmentSource, id, attempt]);
  return signed && signed.id === id && signed.attempt === attempt ? signed.source : null;
}

/** How many loads failed, and which signed source is on screen. */
type LoadState = { attempt: number; errors: number };
type LoadAction = 'error' | 'reload';

/** A proof is single-use and lives ±60 s: the first failure (an expired token, a stale proof, a blip) is
 * retried once with a fresh one on its own; a second failure waits for a tap, so a dead link never loops. */
function loadReducer(s: LoadState, action: LoadAction): LoadState {
  if (action === 'reload') return { attempt: s.attempt + 1, errors: s.errors };
  const errors = s.errors + 1;
  return { attempt: errors === 1 ? s.attempt + 1 : s.attempt, errors };
}

/** The thumbnail's box (`h-40 w-40`), and its smallest side once the size is known (a tappable reload). */
const THUMB_BOX = 160;
const THUMB_MIN = 64;

type Size = { width: number; height: number };

function AuthImage({ attachment, className, resizeMode, size }: { attachment: TChatAttachment; className: string; resizeMode: 'cover' | 'contain'; size?: Size | null }) {
  const { t } = useTranslation();
  const [load, dispatch] = useReducer(loadReducer, { attempt: 0, errors: 0 });
  const source = useAttachmentSource(attachment.id, load.attempt);
  const stuck = load.errors >= 2 && load.attempt < load.errors;
  // Every state takes the same box, so the row never changes size when the image arrives (TER-197).
  const style = size ?? undefined;
  if (stuck) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={t('Toque para recarregar')} onPress={() => dispatch('reload')} className={`${className} items-center justify-center bg-app-surface2`} style={style}>
        <Text className="text-xs text-app-muted">{t('Toque para recarregar')}</Text>
      </Pressable>
    );
  }
  if (!source) return <View testID="attachment-placeholder" className={`${className} bg-app-surface2`} style={style} />;
  return <Image source={source} accessibilityLabel={attachment.name} resizeMode={resizeMode} className={className} style={style} onError={() => dispatch('error')} />;
}

/** Whole seconds as `m:ss`. */
const clock = (total: number) => {
  const s = Math.max(0, Math.floor(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The clip's length as the server measured it (`meta.duration_s`), or `null` before it knows. */
function metaDuration(meta: Record<string, unknown> | null): number | null {
  const d = meta?.duration_s;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null;
}

const PLAY_ICON = { ios: 'play.fill', android: 'play_arrow' } as const;
const PAUSE_ICON = { ios: 'pause.fill', android: 'pause' } as const;

/**
 * A voice note, or any sent audio (TER-1036): play/pause, where it is and how long it lasts, and the
 * transcription the server made of it, folded away until asked for. The bubble's attachment is the one
 * the message was sent with ("transcrevendo…"); what the socket heard since (`attachmentStatuses`) is
 * newer, so the transcription shows up the moment it is ready. The clip is only downloaded on the first
 * play, into the cache (`cachedAudio`): a thread full of notes fetches nothing on open. A transcription
 * whisper could not do offers "Tentar de novo" (TER-1035), which the parent runs.
 */
function AudioAttachment({ attachment, retrying, retryError, onRetry }: { attachment: TChatAttachment; retrying: boolean; retryError: string | null; onRetry: (id: string) => void }) {
  const { t } = useTranslation();
  const heard = useChatStore((s) => s.attachmentStatuses[attachment.id]);
  const sign = useChatStore((s) => s.attachmentSource);
  const a = heard ?? attachment;
  const player = useAudioPlayer(null);
  const playback = useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const duration = metaDuration(a.meta) ?? (playback.duration > 0 ? playback.duration : null);
  const status = attachmentStatusText(a);
  const transcript = typeof a.transcript === 'string' && a.transcript.trim() ? a.transcript.trim() : null;

  const toggle = async () => {
    if (playback.playing) {
      player.pause();
      return;
    }
    if (!loaded) {
      setLoading(true);
      setFailed(false);
      try {
        player.replace({ uri: await cachedAudio(a, sign) });
        setLoaded(true);
      } catch {
        setFailed(true);
        return;
      } finally {
        setLoading(false);
      }
    }
    // Heard with the phone on silent, as a voice note is; and from the start again once it ended.
    await setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    if (playback.didJustFinish || (playback.duration > 0 && playback.currentTime >= playback.duration)) await player.seekTo(0).catch(() => undefined);
    player.play();
  };

  return (
    <View className="min-w-52 gap-1 rounded-lg bg-black/10 px-2 py-1.5">
      <View className="flex-row items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={playback.playing ? t('Pausar áudio') : t('Reproduzir áudio')}
          onPress={() => void toggle()}
          disabled={loading}
          hitSlop={6}
          className="h-8 w-8 items-center justify-center rounded-full bg-white"
        >
          {loading ? <ActivityIndicator size="small" /> : <Icon name={playback.playing ? PAUSE_ICON : PLAY_ICON} size={14} tone="accent" />}
        </Pressable>
        <Text className="text-xs text-white/80">
          {playback.playing || playback.currentTime > 0 ? `${clock(playback.currentTime)} / ` : ''}
          {duration !== null ? clock(duration) : '–:––'}
        </Text>
      </View>
      {failed ? <Text className="text-xs text-white/80">{t('Não foi possível carregar o áudio')}</Text> : null}
      {transcript ? (
        <>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} hitSlop={4}>
            <Text className="text-xs text-white/70 underline">{open ? t('Ocultar transcrição') : t('Ver transcrição')}</Text>
          </Pressable>
          {open ? <Text className="text-sm text-white">{transcript}</Text> : null}
        </>
      ) : status ? (
        <Text className={`text-xs ${a.status === 'failed' ? 'text-app-danger' : 'text-white/70'}`}>{status}</Text>
      ) : null}
      {canRetryAttachment(a) ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('Tentar de novo')} disabled={retrying} onPress={() => onRetry(a.id)} className="self-start rounded-md bg-black/20 px-2 py-1" hitSlop={8}>
          <Text className={`text-xs text-white ${retrying ? 'opacity-50' : ''}`}>{t('Tentar de novo')}</Text>
        </Pressable>
      ) : null}
      {retryError ? <Text className="text-xs text-app-danger">{retryError}</Text> : null}
    </View>
  );
}

/**
 * What the person sent with a message (spec 2026-09-26 §5.6): an image as a thumbnail that opens full
 * screen; a sound as a player with its transcription (TER-1036); every other kind as its name, size and status — opening a file on the phone is out of scope.
 * The size, the `·` and the status are separate `Text`s, so each reads as exactly its own text.
 */
export const MessageAttachments = memo(function MessageAttachments({ attachments }: { attachments: TChatAttachment[] }) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState<TChatAttachment | null>(null);
  const retryAttachment = useChatStore((s) => s.retryAttachment);
  /** The ids whose retry is on its way, and the one the server refused, with why (TER-1035). */
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null);
  const retry = (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    setRetryError(null);
    // The bubble moves to "transcrevendo…" with the `attachment_status` the server publishes.
    retryAttachment(id)
      .catch((e: unknown) => setRetryError({ id, message: e instanceof ApiError ? e.message : t('Não foi possível tentar de novo') }))
      .finally(() =>
        setRetrying((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      );
  };
  return (
    <View className="mt-2 gap-2">
      {attachments.map((a) => {
        if (a.kind === 'image') {
          return (
            <Pressable key={a.id} accessibilityRole="button" accessibilityLabel={t('Abrir imagem {{name}}', { name: a.name })} onPress={() => setViewing(a)}>
              <AuthImage attachment={a} className="h-40 w-40 rounded-lg" resizeMode="cover" size={thumbSize(a.meta, THUMB_BOX, THUMB_MIN)} />
            </Pressable>
          );
        }
        if (a.kind === 'audio') {
          return <AudioAttachment key={a.id} attachment={a} retrying={retrying.has(a.id)} retryError={retryError?.id === a.id ? retryError.message : null} onRetry={retry} />;
        }
        const status = attachmentStatusText(a);
        const tone = a.status === 'failed' ? 'text-app-danger' : 'text-white/70';
        return (
          <View key={a.id} className="flex-row items-center gap-2 rounded-lg bg-black/10 px-2 py-1">
            <Icon name={KIND_ICON[a.kind] ?? ATTACHMENT_ICON} size={18} color="rgba(255,255,255,0.85)" />
            <View className="shrink">
              <Text className="text-sm text-white" numberOfLines={1}>
                {a.name}
              </Text>
              <View className="flex-row items-center gap-1">
                <Text className={`text-xs ${tone}`}>{formatBytes(a.bytes)}</Text>
                {status ? (
                  <>
                    <Text className={`text-xs ${tone}`}>·</Text>
                    <Text className={`text-xs ${tone}`}>{status}</Text>
                  </>
                ) : null}
              </View>
              {retryError?.id === a.id ? <Text className="text-xs text-app-danger">{retryError.message}</Text> : null}
            </View>
            {canRetryAttachment(a) ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t('Tentar de novo')} disabled={retrying.has(a.id)} onPress={() => retry(a.id)} className="rounded-md bg-black/20 px-2 py-1" hitSlop={8}>
                <Text className={`text-xs text-white ${retrying.has(a.id) ? 'opacity-50' : ''}`}>{t('Tentar de novo')}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
      <Modal visible={viewing !== null} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable className="flex-1 items-center justify-center bg-black/95" accessibilityRole="button" accessibilityLabel={t('Fechar imagem')} onPress={() => setViewing(null)}>
          {viewing ? <AuthImage attachment={viewing} className="h-full w-full" resizeMode="contain" /> : null}
        </Pressable>
      </Modal>
    </View>
  );
});
