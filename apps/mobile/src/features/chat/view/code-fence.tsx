import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { RenderRules } from 'react-native-markdown-display';
import { t, tk, useTranslation } from '@/i18n';
import { codeFileExtension, codeFileName, fenceLanguage } from '../model/code-file';
import { saveCodeFile } from '../viewmodel/code-file-save';

/** How long "Copiado ✓" (or the failure) stays on the button before it reads "Copiar" again. */
export const COPY_FLASH_MS = 2000;

/** What a copy attempt ended as: the button's words and the sentence a screen reader hears (pt-BR keys). */
const OUTCOME = {
  copied: { label: tk('Copiado ✓'), announced: tk('Código copiado') },
  failed: { label: tk('Não foi possível copiar'), announced: tk('Não foi possível copiar o código') },
} as const;

/** The block's exact text: the parser hands it over with one trailing newline, which is not code. */
export const codeOf = (content: string): string => (content.endsWith('\n') ? content.slice(0, -1) : content);

type Props = {
  /** The block's text as the parser gives it: with the fence's own trailing newline. */
  content: string;
  /** The fence's info string (` ```bash ` → `bash`); empty for an indented block. */
  info: string;
  style: StyleProp<TextStyle>;
  /** Swapped in tests; the phone's share sheet or folder picker otherwise. */
  save?: (name: string, content: string, ext: string) => Promise<boolean>;
};

/**
 * A code block of an answer: the library's own fence look, under a header with the language and two
 * always-visible buttons (a phone has no hover). "Copiar" (TER-994) copies exactly the block's text,
 * says "Copiado ✓" for a moment and announces it, or says so when the copy fails; "Baixar" (TER-1084)
 * saves the block's text as a file (`saveCodeFile`). Inline code is not a fence and never gets one.
 */
export function CodeFence({ content, info, style, save = saveCodeFile }: Props): ReactNode {
  useTranslation();
  const language = fenceLanguage(info);
  // The parser sends one newline too many at the end (the library trims it the same way to show it);
  // the copy drops it too, while the file keeps the block's own last line break.
  const shown = codeOf(content);

  const [outcome, setOutcome] = useState<keyof typeof OUTCOME | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = (next: keyof typeof OUTCOME) => {
    setOutcome(next);
    AccessibilityInfo.announceForAccessibility(t(OUTCOME[next].announced));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), COPY_FLASH_MS);
  };
  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(shown);
      flash('copied');
    } catch {
      flash('failed');
    }
  };

  const onSave = () => {
    const ext = codeFileExtension(language);
    void save(codeFileName(content, language), content, ext).catch(() => undefined);
  };
  const copyTone = outcome === 'failed' ? 'text-app-danger' : outcome === 'copied' ? 'text-app-ok' : 'text-app-muted';
  return (
    <View className="my-1 overflow-hidden rounded-md border border-app-border">
      <View className="flex-row items-center justify-between border-b border-app-border bg-app-surface2 pl-3 pr-1">
        <Text className="flex-1 text-[11px] uppercase tracking-wide text-app-muted" numberOfLines={1}>
          {language ?? t('código')}
        </Text>
        <View className="flex-row items-center">
          <Pressable accessibilityRole="button" accessibilityLabel={t('Copiar código')} onPress={() => void onCopy()} hitSlop={8} className="min-h-[32px] justify-center px-2">
            <Text className={`text-xs ${copyTone}`}>{outcome ? t(OUTCOME[outcome].label) : t('Copiar')}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={t('Baixar como arquivo')} onPress={onSave} hitSlop={8} className="min-h-[32px] justify-center px-2">
            <Text className="text-xs text-app-muted">{t('Baixar')}</Text>
          </Pressable>
        </View>
      </View>
      <Text selectable style={[style, { borderWidth: 0, borderRadius: 0, marginBottom: 0 }]}>
        {shown}
      </Text>
    </View>
  );
}

/** The markdown rules that put `CodeFence` on every fenced and indented code block of an answer. */
export const codeFenceRules: RenderRules = {
  fence: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <CodeFence key={node.key} content={node.content} info={String((node as { sourceInfo?: string }).sourceInfo ?? '')} style={[inheritedStyles, styles.fence]} />
  ),
  code_block: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <CodeFence key={node.key} content={node.content} info="" style={[inheritedStyles, styles.code_block]} />
  ),
};
