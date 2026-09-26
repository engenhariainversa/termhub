import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';
import { MAX_ATTACHMENTS_PER_MESSAGE, type TChatAttachment } from '@/services/api/contract';
import { CHAT_MSG } from '../model/messages';
import { useAttachmentDrafts, type PickedFile } from '../viewmodel/attachments';
import { useVoice } from '../viewmodel/use-voice';
import { AttachmentChip } from './attachment-chip';
import { AttachmentSheet } from './attachment-sheet';

/** The box's line box for 16 px text; its height follows the content between one and six of these. */
const LINE_HEIGHT = 22;
const MIN_LINES = 1;
const MAX_LINES = 6;
/** The number of chips 📎 stops at. */
const MAX_CHIPS = MAX_ATTACHMENTS_PER_MESSAGE;

/** What the single round button does right now. Exactly one of these, in every state. */
type PrimaryRole = 'dictate' | 'send' | 'stop';

const PRIMARY_LABEL: Record<PrimaryRole, string> = { dictate: 'Ditar', send: 'Enviar', stop: 'Parar' };
const PRIMARY_GLYPH: Record<PrimaryRole, string> = { dictate: '🎤', send: '↑', stop: '■' };

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

type Props = {
  sending: boolean;
  /** Resolves `true` once the server accepted the message: the chips clear then (the text cleared already). */
  onSend(text: string, attachments: TChatAttachment[]): Promise<boolean>;
  uploadAttachment(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  deleteAttachment(id: string): Promise<void>;
  /** The store's `attachmentStatuses`: what the socket heard for each upload, so a chip moves on from "processando…". */
  attachmentStatuses?: Readonly<Record<string, TChatAttachment>>;
};

/**
 * The message box (chat redesign spec §4.2 "Composer", attachments spec 2026-09-26 §5.6): one rounded
 * box holding, top to bottom, the attachment chips, a `TextInput` whose height follows its content
 * between one and six lines, and a row with 📎 on the left and the one round button on the right — a
 * microphone with nothing typed and no chips, the send arrow with text or chips, a stop square while
 * recording, the web's rules. Nothing leaves while a chip is still uploading, and nothing leaves
 * with a chip the server could not read (it would answer 409): the line says to remove it. The text
 * clears as soon as it is sent and comes back if the send fails; the chips only go once the server
 * accepted. The status, error and notice lines are always mounted, so text appearing in them moves
 * nothing.
 */
export function Composer({ sending, onSend, uploadAttachment, deleteAttachment, attachmentStatuses }: Props) {
  const [text, setText] = useState('');
  const [height, setHeight] = useState(LINE_HEIGHT * MIN_LINES);
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState(false);
  const voice = useVoice(useCallback((clip: string) => setText((current) => appendDictated(current, clip)), []));
  const attachments = useAttachmentDrafts({ upload: uploadAttachment, remove: deleteAttachment, statuses: attachmentStatuses });

  const hasText = text.trim().length > 0;
  /** A chip that is (or will be) part of the message: uploading or uploaded; a refused one is not. */
  const hasChips = attachments.drafts.some((d) => d.phase !== 'failed');
  const invalid = attachments.invalid.length > 0;
  const canSend = (hasText || attachments.uploaded.length > 0) && !attachments.uploading && !invalid && !sending;

  // The box empties at once (the row is already on screen) and gets its text back if the send
  // fails — unless something new was typed meanwhile, which is the person's to keep. The chips stay
  // until the server accepted, and only the ones this send carried go: one picked meanwhile is the
  // next message's.
  const submit = async () => {
    if (!canSend) return;
    const sent = text;
    const carried = attachments.drafts.filter((d) => d.phase === 'uploaded' && d.attachment !== null);
    setText('');
    if (await onSend(sent, carried.map((d) => d.attachment!))) attachments.clear(carried.map((d) => d.key));
    else setText((current) => current || sent);
  };

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
    setHeight(Math.min(LINE_HEIGHT * MAX_LINES, Math.max(LINE_HEIGHT * MIN_LINES, Math.ceil(e.nativeEvent.contentSize.height))));

  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = voice.state === 'uploading' || voice.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed and no chips the button dictates — unless dictation is off, where the empty box
  // keeps the (disabled) send button. While `checking` or `starting` it is the microphone, disabled.
  const role: PrimaryRole = voice.state === 'recording' ? 'stop' : hasText || hasChips || voice.state === 'off' ? 'send' : 'dictate';
  const disabled = role === 'stop' ? false : role === 'send' ? !canSend || busy : busy || voice.state === 'checking' || voice.state === 'starting';
  const statusText = busy
    ? 'transcrevendo…'
    : attachments.uploading
      ? CHAT_MSG.attachmentUploading
      : invalid
        ? CHAT_MSG.attachmentInvalid
        : (attachments.notice ?? '');
  const onPrimary = role === 'stop' ? voice.stop : role === 'send' ? () => void submit() : voice.start;
  // No 📎 while dictation holds the microphone or its clip: the sheet's recorder would release the
  // audio session under it (one recorder at a time), and five chips is the message's limit.
  const attachOff = attachments.drafts.length >= MAX_CHIPS || voice.state === 'starting' || voice.state === 'recording' || busy;

  return (
    <View className="border-t border-app-border bg-app-bg px-3 pb-2 pt-2">
      <View className={`rounded-2xl border bg-app-surface px-3 py-2 ${focused ? 'border-app-accent' : 'border-app-border'}`}>
        {attachments.drafts.length > 0 ? (
          <View className="mb-2 gap-2">
            {attachments.drafts.map((d) => (
              <AttachmentChip key={d.key} draft={d} onRemove={() => attachments.remove(d.key)} onRetry={() => attachments.retry(d.key)} />
            ))}
          </View>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Mensagem"
          accessibilityLabel="Mensagem"
          multiline
          onContentSizeChange={onContentSizeChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          scrollEnabled={height >= LINE_HEIGHT * MAX_LINES}
          style={{ height, lineHeight: LINE_HEIGHT }}
          className="px-0 py-0 text-base text-app-text placeholder:text-app-muted"
        />
        <View className="mt-2 h-10 flex-row items-center gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Anexar"
            accessibilityState={{ disabled: attachOff }}
            disabled={attachOff}
            onPress={() => setPicking(true)}
            hitSlop={8}
            className={`h-9 w-9 items-center justify-center rounded-full ${attachOff ? 'opacity-50' : ''}`}
          >
            <Text className="text-lg">📎</Text>
          </Pressable>
          {/* While recording the row shows the clip is listening, for how long, and lets it be dropped. */}
          <View className="flex-1 flex-row items-center gap-2">
            {voice.state === 'recording' ? (
              <>
                <View className="h-2 w-2 rounded-full bg-app-danger" />
                <Text className="text-xs text-app-text">{formatClock(voice.seconds)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancelar gravação" onPress={voice.cancel} className="px-2 py-1">
                  <Text className="text-xs text-app-muted">cancelar</Text>
                </Pressable>
              </>
            ) : null}
          </View>
          <Text className="text-xs text-app-muted" numberOfLines={1}>
            {statusText}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={PRIMARY_LABEL[role]}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPrimary}
            className={`h-10 w-10 items-center justify-center rounded-full bg-app-accent ${disabled ? 'opacity-50' : ''}`}
          >
            <Text className="text-lg text-white">{PRIMARY_GLYPH[role]}</Text>
          </Pressable>
        </View>
      </View>
      <Text className="h-4 px-1 text-xs text-app-danger" numberOfLines={1}>
        {voice.error ?? ''}
      </Text>
      <Text className="h-4 px-1 text-xs text-app-muted" numberOfLines={1}>
        {voice.notice ?? ''}
      </Text>
      <AttachmentSheet open={picking} room={Math.max(0, MAX_CHIPS - attachments.drafts.length)} onClose={() => setPicking(false)} onPicked={attachments.add} />
    </View>
  );
}
