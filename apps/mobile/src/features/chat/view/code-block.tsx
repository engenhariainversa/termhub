import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { RenderRules } from 'react-native-markdown-display';
import { t, tk, useTranslation } from '@/i18n';

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
  code: string;
  /** The fence's info string ("ts", "bash"…); none for an indented block. */
  language?: string;
  /** The renderer's style for the block's text (`fence` / `code_block` of markdown-style.ts). */
  textStyle?: StyleProp<TextStyle>;
};

/**
 * A code block of an answer (TER-994, the app's half of TER-992): a header with the language and a
 * "Copiar" button that is always shown — a phone has no hover. A tap copies exactly the block's
 * text, says "Copiado ✓" for a moment and announces it; a copy that throws says so the same way
 * instead of failing silently.
 */
export function CodeBlock({ code, language, textStyle }: Props) {
  useTranslation();
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
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(code);
      flash('copied');
    } catch {
      flash('failed');
    }
  };

  return (
    <View className="my-1 overflow-hidden rounded border border-app-border bg-app-surface2">
      <View className="flex-row items-center justify-between gap-2 border-b border-app-border pl-2.5">
        <Text className="flex-1 text-xs text-app-muted" numberOfLines={1}>
          {language ?? ''}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Copiar código')} hitSlop={6} onPress={() => void copy()} className="px-2.5 py-1.5">
          <Text className={`text-xs ${outcome === 'failed' ? 'text-app-danger' : outcome === 'copied' ? 'text-app-ok' : 'text-app-accent'}`}>
            {outcome ? t(OUTCOME[outcome].label) : t('Copiar')}
          </Text>
        </Pressable>
      </View>
      <Text selectable style={[textStyle, { borderWidth: 0, borderRadius: 0, marginTop: 0, marginBottom: 0 }]}>
        {code}
      </Text>
    </View>
  );
}

/** The fence's language: the first word of its info string. */
const languageOf = (info: unknown): string | undefined => (typeof info === 'string' ? info.trim().split(/\s+/)[0] || undefined : undefined);

/** Markdown rules of an answer: fenced and indented blocks get the copy header; inline code stays as is. */
export const codeRules: RenderRules = {
  fence: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <CodeBlock key={node.key} code={codeOf(node.content)} language={languageOf((node as { sourceInfo?: unknown }).sourceInfo)} textStyle={[inheritedStyles, styles.fence]} />
  ),
  code_block: (node, _children, _parent, styles, inheritedStyles = {}) => (
    <CodeBlock key={node.key} code={codeOf(node.content)} textStyle={[inheritedStyles, styles.code_block]} />
  ),
};
