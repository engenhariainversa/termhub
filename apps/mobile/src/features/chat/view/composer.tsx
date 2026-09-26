import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';
import { useVoice } from '../viewmodel/use-voice';

/** The box's line box for 16 px text; its height follows the content between one and six of these. */
const LINE_HEIGHT = 22;
const MIN_LINES = 1;
const MAX_LINES = 6;

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

/**
 * The message box (chat redesign spec §4.2 "Composer"): one rounded box holding, top to bottom, the
 * attachment chips (phase B), a `TextInput` whose height follows its content between one and six
 * lines, and a row with the 📎 slot on the left (empty until B10) and the one round button on the
 * right — a microphone with nothing typed, the send arrow with text, a stop square while recording,
 * the web's rules. The text clears as soon as it is sent and comes back if the send fails. The
 * status, error and notice lines are always mounted, so text appearing in them moves nothing.
 */
export function Composer({ sending, onSend }: { sending: boolean; onSend(text: string): Promise<boolean> }) {
  const [text, setText] = useState('');
  const [height, setHeight] = useState(LINE_HEIGHT * MIN_LINES);
  const [focused, setFocused] = useState(false);
  const voice = useVoice(useCallback((clip: string) => setText((current) => appendDictated(current, clip)), []));

  // The box empties at once (the row is already on screen) and gets its text back if the send
  // fails — unless something new was typed meanwhile, which is the person's to keep.
  const submit = async () => {
    const sent = text;
    setText('');
    if (!(await onSend(sent))) setText((current) => current || sent);
  };

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) =>
    setHeight(Math.min(LINE_HEIGHT * MAX_LINES, Math.max(LINE_HEIGHT * MIN_LINES, Math.ceil(e.nativeEvent.contentSize.height))));

  const hasText = text.trim().length > 0;
  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = voice.state === 'uploading' || voice.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed the button dictates — unless dictation is off, where the empty box keeps the
  // (disabled) send button. While `checking` or `starting` it is the microphone, disabled.
  const role: PrimaryRole = voice.state === 'recording' ? 'stop' : hasText || voice.state === 'off' ? 'send' : 'dictate';
  const disabled = role === 'stop' ? false : role === 'send' ? !hasText || sending || busy : busy || voice.state === 'checking' || voice.state === 'starting';
  const statusText = busy ? 'transcrevendo…' : sending && role === 'send' ? 'aguarde a resposta terminar' : '';
  const onPrimary = role === 'stop' ? voice.stop : role === 'send' ? () => void submit() : voice.start;

  return (
    <View className="border-t border-app-border bg-app-bg px-3 pb-2 pt-2">
      <View className={`rounded-2xl border bg-app-surface px-3 py-2 ${focused ? 'border-app-accent' : 'border-app-border'}`}>
        {/* Attachment chips go here (phase B, Task B10). */}
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
          {/* The 📎 button sits here (B10); until then the slot is empty and keeps the row's layout.
              While recording it shows the clip is listening, for how long, and lets it be dropped. */}
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
    </View>
  );
}
