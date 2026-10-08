import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { MAX_ATTACHMENTS_PER_MESSAGE, type TChatAttachment } from '@/services/api/contract';
import { useTranslation } from '@/i18n';
import { Icon, useAfterKeyboardMoves, type IconName } from '@/ui';
import { onChatFiles, takeChatFiles } from '../model/chat-inbox';
import { CHAT_MSG } from '../model/messages';
import { useAttachmentDrafts, type PickedFile } from '../viewmodel/attachments';
import { useVoice, type RecordedClip } from '../viewmodel/use-voice';
import { useVoiceNote, type VoiceNote } from '../viewmodel/use-voice-note';
import type { ReplyRef } from '../model/reply';
import { AttachmentChip } from './attachment-chip';
import { AttachmentMenu, type MenuAnchor } from './attachment-menu';
import { RecordingWave } from './recording-wave';
import { ReplyPreview } from './reply-preview';

/** The box's line box for 16 px text; its height follows the content between `MIN_ROWS` and
 * `MAX_ROWS` of these (the web composer's names), and past that it scrolls. */
const LINE_HEIGHT = 22;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const MIN_HEIGHT = LINE_HEIGHT * MIN_ROWS;
const MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS;
/** The buttons' row (`h-9`), and the pill's padding around its content (`px-1 py-1.5`). */
const ROW_HEIGHT = 36;
const PILL_X = 4;
const PILL_Y = 6;
/** The gap between the row's items (`gap-2`), and between the text and a button beside it. */
const ROW_ITEM_GAP = 8;
const TEXT_GAP = 4;
/** How far the text keeps off a side while it shares the row with `buttons` buttons there. */
const beside = (buttons: number) => (buttons === 0 ? 0 : buttons * ROW_HEIGHT + (buttons - 1) * ROW_ITEM_GAP + TEXT_GAP);
/** Where the text starts on its own line, and the gap between it and the buttons' row. */
const TEXT_INSET = 8;
const TEXT_TOP = 6;
const ROW_GAP = 4;
/** The pill growing a line, or the text moving between the buttons' line and its own: ChatGPT's glide. */
const GLIDE = { duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };

/** The box has wrapped once it is nearer two lines than one: a line a fraction taller than
 * `LINE_HEIGHT` (a font, a display scale) is still one line. */
const WRAPPED_FROM = MIN_HEIGHT + LINE_HEIGHT / 2;

/**
 * The text's frame inside the pill. The buttons' row is pinned to the pill's bottom in both layouts;
 * sharing it, the text sits between + the `rightButtons` on the right (the microphone, and ↑ once
 * there is something to send), centred on the row; on its own, it takes the whole width and keeps the
 * row free below. The pill's height is whatever this frame adds up to.
 */
function textFrame(stacked: boolean, height: number, rightButtons: number) {
  return stacked
    ? { left: TEXT_INSET, right: TEXT_INSET, top: TEXT_TOP, height: TEXT_TOP + height, below: ROW_HEIGHT + ROW_GAP }
    : { left: beside(1), right: beside(rightButtons), top: (ROW_HEIGHT - LINE_HEIGHT) / 2, height: ROW_HEIGHT, below: 0 };
}

/** While recording the whole pill is the recording row: the text folds away (it is kept, not cleared). */
const RECORDING_FRAME = { left: TEXT_INSET, right: TEXT_INSET, top: 0, height: 0, below: ROW_HEIGHT };

/** A number that glides to each new target, or jumps there when the system asks for reduced motion. */
function useGlide(target: number, still: boolean): SharedValue<number> {
  const value = useSharedValue(target);
  useEffect(() => {
    value.set(still ? target : withTiming(target, GLIDE));
  }, [target, still, value]);
  return value;
}

/** How long the + waits for the keyboard to finish going down before it opens its menu anyway. */
const KEYBOARD_SETTLE_MS = 700;
/** The number of chips the + menu stops at. */
const MAX_CHIPS = MAX_ATTACHMENTS_PER_MESSAGE;

const MIC_ICON: IconName = { ios: 'mic', android: 'mic' };
const SEND_ICON: IconName = { ios: 'arrow.up', android: 'arrow_upward' };
const STOP_ICON: IconName = { ios: 'stop.fill', android: 'stop' };
const CANCEL_ICON: IconName = { ios: 'xmark', android: 'close' };
const ATTACH_ICON: IconName = { ios: 'plus', android: 'add' };
const LOCK_ICON: IconName = { ios: 'lock.fill', android: 'lock' };
const LOCK_UP_ICON: IconName = { ios: 'chevron.up', android: 'keyboard_arrow_up' };
const DISCARD_ICON: IconName = { ios: 'trash', android: 'delete' };

/**
 * Appends a transcription to whatever is already in the box — the web's `appendDictated`, verbatim.
 * Whisper returns its own leading/trailing spaces, so the clip is trimmed and a single space is
 * inserted, except when the box is empty (no leading space) or already ends in whitespace, where the
 * separator the person typed is kept exactly. A clip that trims away to nothing leaves the box alone.
 */
export function appendDictated(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  if (!current) return clip;
  return /\s$/.test(current) ? current + clip : `${current} ${clip}`;
}

/** Whole seconds as `m:ss` — 65 reads as `1:05`, the way a stopwatch is read. */
const formatClock = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

/** A voice note's file name: when it was recorded, as the old "Gravar áudio" named its clips. */
const voiceNoteName = () => `audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.m4a`;

type Props = {
  sending: boolean;
  /** Resolves `true` once the server accepted the message: the chips clear then (the text cleared already). */
  onSend(text: string, attachments: TChatAttachment[]): Promise<boolean>;
  uploadAttachment(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  deleteAttachment(id: string): Promise<void>;
  /** The store's `attachmentStatuses`: what the socket heard for each upload, so a chip moves on from "processando…". */
  attachmentStatuses?: Readonly<Record<string, TChatAttachment>>;
  /** The message the next send answers (TER-447), previewed on top of the pill; the screen owns it. */
  replyTo?: ReplyRef | null;
  /** ✕ on the preview. */
  onCancelReply?(): void;
  /** Nothing can be typed or sent (a session whose machine is offline, spec 2026-10-01 tab chat §7). */
  disabled?: boolean;
  /** Set while the other side works (a terminal session): ↑ becomes "Interromper", always shown, and a
   * long press on it still sends what is typed (Claude Code queues it). */
  onInterrupt?(): void;
  /** The chat this box belongs to (`inboxKey`): files sent here from a file preview land as chips. */
  inbox?: string;
};

/** A round button of the pill: the symbol on a filled circle (`fill`) or bare. */
function RoundButton({ label, icon, onPress, onLongPress, disabled = false, fill, tone }: { label: string; icon: IconName; onPress(): void; onLongPress?(): void; disabled?: boolean; fill?: string; tone: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={4}
      className={`h-9 w-9 items-center justify-center rounded-full ${fill ?? ''} ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon name={icon} size={fill ? 16 : 20} tone={tone} />
    </Pressable>
  );
}

/**
 * The microphone of an empty box (TER-1036): a voice note is recorded while it is held. It is a bare
 * responder view rather than a `Pressable`, because the finger has to be followed after it goes down
 * (left drops the clip, up locks it) and the touch must not be handed to anyone else while it records.
 * Above it, while held, the lock it slides up to. A screen reader cannot hold, so its activation starts
 * a locked recording straight away, with ✕ and ↑ to end it.
 */
function HoldMic({ note, disabled }: { note: VoiceNote; disabled: boolean }) {
  const { t } = useTranslation();
  const origin = useRef({ x: 0, y: 0 });
  const holding = note.state === 'holding';
  return (
    <View>
      {holding ? (
        <View pointerEvents="none" testID="voice-note-lock" style={{ position: 'absolute', bottom: ROW_HEIGHT + 12, left: 0, right: 0 }} className="items-center gap-1 rounded-full bg-app-surface py-2">
          <Icon name={LOCK_ICON} size={14} tone="muted" />
          <Icon name={LOCK_UP_ICON} size={12} tone="muted" />
        </View>
      ) : null}
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t('Gravar áudio')}
        accessibilityHint={t('Segure para gravar')}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'activate' }]}
        onAccessibilityAction={(e) => {
          if (!disabled && e.nativeEvent.actionName === 'activate') note.startLocked();
        }}
        onStartShouldSetResponder={() => !disabled}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          note.press();
        }}
        onResponderMove={(e) => note.move(e.nativeEvent.pageX - origin.current.x, e.nativeEvent.pageY - origin.current.y)}
        onResponderRelease={note.release}
        onResponderTerminate={note.interrupt}
        hitSlop={4}
        className={`h-9 w-9 items-center justify-center rounded-full ${holding ? 'bg-app-danger' : ''} ${disabled ? 'opacity-40' : ''}`}
      >
        <Icon name={MIC_ICON} size={20} tone={holding ? 'bg' : 'text'} />
      </View>
    </View>
  );
}

/**
 * The message box (chat redesign spec §4.2 "Composer", attachments spec 2026-09-26 §5.6): one rounded
 * pill holding the attachment chips on top and a `TextInput` whose height follows its content between
 * `MIN_ROWS` and `MAX_ROWS` lines. While the text fits on one line, +, the text and the buttons on the
 * right (the microphone while the box is empty, ↑ once there is text or a chip) sit side by
 * side; once it wraps (or with a status to show) the text takes the pill's whole width and the buttons
 * get a row of their own under it, inside the pill — the web composer's "one box, two rows". The
 * buttons' row stays pinned to the pill's bottom, next to the keyboard: the pill grows upwards and the
 * text glides between the two places (`GLIDE`), line by line, unless the system asks for reduced motion.
 *
 * The microphone records a voice note while it is held (TER-1036, WhatsApp's): let go and it is sent,
 * slide left and it is dropped, slide up and it locks, recording on with ✕ and ↑ to end it. The clip
 * goes into the box as an audio chip and leaves on its own, without text, once it has uploaded; the
 * server transcribes it like any audio attachment. A failed upload leaves the chip, to retry or send.
 *
 * + opens the attachment menu above it, which also holds dictation ("Ditar"; the phone's keyboard has
 * its own). While dictating, the whole pill is the recording row (ChatGPT's):
 * ✕ drops the clip, the wave follows the microphone, ■ stops and puts the transcription in the box to
 * be read first (what dictation always did), and ↑ stops and sends the box with the transcription once
 * it arrives — a send the person asked for, like tapping ↑; a clip that fails or hears nothing sends
 * nothing. Nothing leaves while a chip is still uploading, and nothing leaves with a chip the server
 * could not read (it would answer 409): the line says to remove it. A message being answered
 * (TER-447) is previewed on top of the pill, with ✕; the screen keeps the reference and sends it. The text clears as soon as it is
 * sent and comes back if the send fails; the chips only go once the server accepted.
 */
export function Composer({ sending, onSend, uploadAttachment, deleteAttachment, attachmentStatuses, replyTo = null, onCancelReply, disabled = false, onInterrupt, inbox }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [height, setHeight] = useState(MIN_HEIGHT);
  // Latched: once the text wraps the buttons stay below until the box is emptied. Leaving as soon as
  // the text fit on one line again would flap, since the text gets wider when the buttons move out.
  const [wrapped, setWrapped] = useState(false);
  const [picking, setPicking] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const attachRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  /** The box as last rendered, for the transcription callback (it runs outside React's render cycle). */
  const textRef = useRef(text);
  textRef.current = text;
  /** ↑ was tapped while recording: the transcription, when it arrives, is sent with the box. */
  const sendAfterDictation = useRef(false);
  const submitRef = useRef<(body: string) => Promise<void>>(async () => undefined);
  const onDictated = useCallback((clip: string) => {
    const next = appendDictated(textRef.current, clip);
    textRef.current = next;
    setText(next);
    if (sendAfterDictation.current) {
      sendAfterDictation.current = false;
      void submitRef.current(next);
    }
  }, []);
  const voice = useVoice(onDictated);
  /** The chip of the voice note that leaves once it has uploaded. */
  const voiceNoteKey = useRef<string | null>(null);
  const onVoiceNote = useCallback((clip: RecordedClip) => {
    const [key] = addRef.current([{ uri: clip.uri, name: voiceNoteName(), mime: clip.mime, bytes: null }]);
    voiceNoteKey.current = key ?? null;
  }, []);
  const note = useVoiceNote(onVoiceNote);
  // Answering is about to be typed: the keyboard comes up with the preview, as in WhatsApp.
  const replyId = replyTo?.id;
  useEffect(() => {
    if (replyId) inputRef.current?.focus();
  }, [replyId]);
  const attachments = useAttachmentDrafts({ upload: uploadAttachment, remove: deleteAttachment, statuses: attachmentStatuses });
  // A file sent from a preview ("Mandar para o chat") lands as a chip, like a picked one.
  const addRef = useRef(attachments.add);
  addRef.current = attachments.add;
  useEffect(() => {
    if (inbox === undefined) return;
    const take = (key: string) => {
      if (key !== inbox) return;
      const files = takeChatFiles(inbox);
      if (files.length > 0) addRef.current(files);
    };
    take(inbox);
    return onChatFiles(take);
  }, [inbox]);

  // The voice note leaves on its own once its chip has uploaded: alone, whatever was typed meanwhile
  // stays in the box. A failed upload keeps the chip (retry, or ↑), and a refused send leaves it too.
  const clearDrafts = attachments.clear;
  useEffect(() => {
    const key = voiceNoteKey.current;
    if (key === null) return;
    const draft = attachments.drafts.find((d) => d.key === key);
    if (!draft || draft.phase === 'failed') {
      voiceNoteKey.current = null;
      return;
    }
    if (draft.phase !== 'uploaded' || !draft.attachment || sending || disabled) return;
    voiceNoteKey.current = null;
    void onSend('', [draft.attachment]).then((ok) => {
      if (ok) clearDrafts([key]);
    });
  }, [attachments.drafts, sending, disabled, onSend, clearDrafts]);

  const hasText = text.trim().length > 0;
  /** A chip that is (or will be) part of the message: uploading or uploaded; a refused one is not. */
  const hasChips = attachments.drafts.some((d) => d.phase !== 'failed');
  const invalid = attachments.invalid.length > 0;
  const sendable = (body: string) => (body.trim().length > 0 || attachments.uploaded.length > 0) && !attachments.uploading && !invalid && !sending && !disabled;
  const canSend = sendable(text);

  // The box empties at once (the row is already on screen) and gets its text back if the send
  // fails — unless something new was typed meanwhile, which is the person's to keep. The chips stay
  // until the server accepted, and only the ones this send carried go: one picked meanwhile is the
  // next message's.
  const submit = async (body: string = text) => {
    if (!sendable(body)) return;
    const carried = attachments.drafts.filter((d) => d.phase === 'uploaded' && d.attachment !== null);
    changeText('');
    if (await onSend(body, carried.map((d) => d.attachment!))) attachments.clear(carried.map((d) => d.key));
    else setText((current) => current || body);
  };
  submitRef.current = submit;

  // An emptied box (sent, or erased) is back to one line at once, without waiting for the native
  // layout; the returned text of a failed send is laid out again by the input.
  const changeText = (next: string) => {
    setText(next);
    if (next === '') {
      setHeight(MIN_HEIGHT);
      setWrapped(false);
    }
  };

  // The input sizes itself to its text (between `MIN_HEIGHT` and `MAX_HEIGHT`) and this is where the
  // pill hears of it. Not `onContentSizeChange`: iOS only sends it when the input's own layout
  // changes, so an input held at a height set from that event never grew past its first line.
  const onInputLayout = (e: LayoutChangeEvent) => {
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.layout.height)));
    setHeight(next);
    if (next >= WRAPPED_FROM) setWrapped(true);
  };

  const recording = voice.state === 'recording';
  /** A voice note is being recorded: the pill is its row, as it is dictation's. */
  const holding = note.state === 'holding';
  const noting = holding || note.state === 'locked';
  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = voice.state === 'uploading' || voice.state === 'transcribing';
  // A clip that ended without a transcription (cancelled, too short, failed, silent) sends nothing:
  // the flag only lives while the clip it was set for is recording or on its way.
  useEffect(() => {
    if (!recording && !busy) sendAfterDictation.current = false;
  }, [recording, busy]);
  // The text folds away while recording, so the keyboard goes with it: nothing types into a hidden box.
  useEffect(() => {
    if (recording || noting) inputRef.current?.blur();
  }, [recording, noting]);

  // WhatsApp's single button on the right: the microphone while the box is empty, ↑ once there is
  // text or a chip. Without transcription on the server there is no microphone (a voice note nobody
  // can read) and the empty box keeps the (disabled) ↑. While `checking` or dictation is `starting` the
  // microphone is there, disabled.
  const showMic = voice.state !== 'off' && !hasText && !hasChips;
  const micDisabled = busy || disabled || voice.state === 'checking' || voice.state === 'starting';
  const showSend = !showMic;
  const sendDisabled = !canSend || busy;
  const statusText = busy
    ? t('transcrevendo…')
    : attachments.uploading
      ? CHAT_MSG.attachmentUploading
      : invalid
        ? CHAT_MSG.attachmentInvalid
        : (attachments.notice ?? '');
  // No + while dictation holds the microphone or its clip: the menu's recorder would release the
  // audio session under it (one recorder at a time), and five chips is the message's limit.
  const attachOff = disabled || attachments.drafts.length >= MAX_CHIPS || voice.state === 'starting' || recording || busy || note.state !== 'idle';
  // The menu hangs off the + (TER-1022), and the + moves with the keyboard: with the keyboard up, it
  // goes down first and the menu opens once the pill has landed; open, the menu follows the button
  // whenever the keyboard moves again. Unmeasured, the menu uses a default place.
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const placeMenu = useCallback(() => {
    attachRef.current?.measureInWindow((x, y) => setAnchor({ x, y }));
    if (!openingRef.current) return;
    openingRef.current = false;
    setOpening(false);
    setPicking(true);
  }, []);
  useAfterKeyboardMoves(placeMenu, picking || opening);
  useEffect(() => {
    if (!opening) return;
    // No "did hide" (the keyboard went down another way meanwhile): open where the button is anyway.
    const timer = setTimeout(placeMenu, KEYBOARD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [opening, placeMenu]);
  const openMenu = () => {
    if (Keyboard.isVisible()) {
      openingRef.current = true;
      setOpening(true);
      Keyboard.dismiss();
      return;
    }
    attachRef.current?.measureInWindow((x, y) => setAnchor({ x, y }));
    setPicking(true);
  };

  // The status line needs the row's middle, which the text covers while it shares the row.
  const stacked = wrapped || statusText !== '';
  const still = useReducedMotion();
  const frame = recording || noting ? RECORDING_FRAME : textFrame(stacked, height, (showMic ? 1 : 0) + (showSend || onInterrupt ? 1 : 0));
  const left = useGlide(frame.left, still);
  const right = useGlide(frame.right, still);
  const top = useGlide(frame.top, still);
  const boxHeight = useGlide(frame.height, still);
  const below = useGlide(frame.below, still);
  const textStyle = useAnimatedStyle(() => ({
    marginLeft: left.get(),
    marginRight: right.get(),
    height: boxHeight.get(),
    marginBottom: below.get(),
  }));
  const inputStyle = useAnimatedStyle(() => ({ top: top.get() }));

  return (
    <View className="bg-app-bg px-3 pb-2 pt-2">
      <View className="rounded-3xl bg-app-surface2 px-1 py-1.5">
        {replyTo ? <ReplyPreview reply={replyTo} onCancel={onCancelReply} /> : null}
        {attachments.drafts.length > 0 ? (
          <View className="mb-2 mt-1 gap-2 px-1">
            {attachments.drafts.map((d) => (
              <AttachmentChip key={d.key} draft={d} onRemove={() => attachments.remove(d.key)} onRetry={() => attachments.retry(d.key)} />
            ))}
          </View>
        ) : null}
        {/* Always mounted, in this order: the row under the text, so where the two meet (the row's
            empty middle while they share it) the input takes the touch. Only the row's own buttons
            change; the input is never remounted: the keyboard stays up and the caret where it was. */}
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', left: PILL_X, right: PILL_X, bottom: PILL_Y, height: ROW_HEIGHT }}
          className="flex-row items-center gap-2"
        >
          {recording ? (
            <>
              <RoundButton label={t('Cancelar gravação')} icon={CANCEL_ICON} onPress={voice.cancel} fill="bg-app-surface" tone="text" />
              <View className="flex-1 flex-row items-center gap-2">
                <RecordingWave level={voice.level} seconds={voice.seconds} />
                <Text className="text-xs text-app-muted">{formatClock(voice.seconds)}</Text>
              </View>
              <RoundButton label={t('Parar')} icon={STOP_ICON} onPress={voice.stop} fill="bg-app-bg" tone="text" />
              <RoundButton
                label={t('Parar e enviar')}
                icon={SEND_ICON}
                onPress={() => {
                  sendAfterDictation.current = true;
                  voice.stop();
                }}
                fill="bg-app-text"
                tone="bg"
              />
            </>
          ) : note.state === 'locked' ? (
            <>
              <RoundButton label={t('Descartar áudio')} icon={DISCARD_ICON} onPress={note.discard} fill="bg-app-surface" tone="text" />
              <View className="flex-1 flex-row items-center gap-2">
                <View className="h-2 w-2 rounded-full bg-app-danger" />
                <Text className="text-xs text-app-muted">{formatClock(note.seconds)}</Text>
                <RecordingWave level={note.level} seconds={note.seconds} />
              </View>
              <RoundButton label={t('Enviar áudio')} icon={SEND_ICON} onPress={note.send} fill="bg-app-text" tone="bg" />
            </>
          ) : (
            <>
              {/* Held, the left of the row is the recording's; the microphone keeps its place in this
                  list in both shapes, so it is the same element under the finger the whole time — a
                  remounted responder would drop the touch it is following. */}
              {holding ? (
                <View className="flex-1 flex-row items-center gap-2 pl-2">
                  <View className="h-2 w-2 rounded-full bg-app-danger" />
                  <Text className="text-xs text-app-muted">{formatClock(note.seconds)}</Text>
                  <RecordingWave level={note.level} seconds={note.seconds} />
                  <Text style={{ transform: [{ translateX: note.slide }] }} className="text-xs text-app-muted" numberOfLines={1}>
                    {t('‹ deslize para cancelar')}
                  </Text>
                </View>
              ) : (
                <>
                  <Pressable
                    ref={attachRef}
                    accessibilityRole="button"
                    accessibilityLabel={t('Anexar')}
                    accessibilityState={{ disabled: attachOff }}
                    disabled={attachOff}
                    onPress={openMenu}
                    hitSlop={8}
                    className={`h-9 w-9 items-center justify-center rounded-full ${attachOff ? 'opacity-50' : ''}`}
                  >
                    <Icon name={ATTACH_ICON} size={22} tone="text" />
                  </Pressable>
                  <View pointerEvents="none" className="flex-1" />
                  {statusText ? (
                    <Text className="shrink text-xs text-app-muted" numberOfLines={1}>
                      {statusText}
                    </Text>
                  ) : null}
                </>
              )}
              {/* The microphone is a plain symbol; ↑ is the filled circle in the text colour, so it
                  inverts with the theme (white on the dark one). */}
              {showMic || holding ? <HoldMic note={note} disabled={micDisabled && !holding} /> : null}
              {holding ? null : onInterrupt ? (
                <RoundButton label={t('Interromper')} icon={STOP_ICON} onPress={onInterrupt} onLongPress={() => void submit()} disabled={disabled} fill="bg-app-text" tone="bg" />
              ) : showSend ? (
                <RoundButton label={t('Enviar')} icon={SEND_ICON} onPress={() => void submit()} disabled={sendDisabled} fill="bg-app-text" tone="bg" />
              ) : null}
            </>
          )}
        </View>
        <Animated.View testID="composer-text" style={[{ overflow: 'hidden' }, textStyle]}>
          {/* Out of the frame's flow, with no height of its own: a measured child (the input) is never
              laid out taller than a parent of a set height, so inside the frame it could not grow
              past the frame, whose height is the input's. Here it is as tall as its text. */}
          <Animated.View testID="composer-input-slot" style={[{ position: 'absolute', left: 0, right: 0 }, inputStyle]}>
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={changeText}
              editable={!disabled}
              placeholder={t('Mensagem')}
              accessibilityLabel={t('Mensagem')}
              multiline
              onLayout={onInputLayout}
              scrollEnabled={height >= MAX_HEIGHT}
              textAlignVertical="top"
              // No height: the input grows and shrinks with its text by itself, on both platforms,
              // between one line and `MAX_ROWS`. No padding of its own (Android adds some by default,
              // iOS some to a multiline input) and no extra font padding: its height is exactly the
              // lines it shows. It takes its new height at once; the frame around it glides, and
              // clips it meanwhile.
              style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT, lineHeight: LINE_HEIGHT, fontSize: 16, padding: 0, paddingTop: 0, paddingBottom: 0, includeFontPadding: false }}
              className="text-app-text placeholder:text-app-muted"
            />
          </Animated.View>
        </Animated.View>
      </View>
      {/* Only when there is something to say: an empty line here would hold the pill off the keyboard. */}
      {(note.error ?? voice.error) ? (
        <Text className="px-1 pt-1 text-xs text-app-danger" numberOfLines={1}>
          {note.error ?? voice.error}
        </Text>
      ) : null}
      {(note.hint ?? voice.notice) ? (
        <Text className="px-1 pt-1 text-xs text-app-muted" numberOfLines={1}>
          {note.hint ?? voice.notice}
        </Text>
      ) : null}
      <AttachmentMenu
        open={picking}
        anchor={anchor}
        room={Math.max(0, MAX_CHIPS - attachments.drafts.length)}
        onClose={() => setPicking(false)}
        onPicked={attachments.add}
        onDictate={voice.state === 'idle' ? voice.start : undefined}
      />
    </View>
  );
}
