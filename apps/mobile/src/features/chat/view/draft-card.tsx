import * as Clipboard from 'expo-clipboard';
import { draftPlainText } from '@termhub/mobile-api';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import Markdown, { type MarkdownIt, type RenderRules } from 'react-native-markdown-display';
import { t, tk, useTranslation } from '@/i18n';
import { codeOf, COPY_FLASH_MS } from './code-fence';

/** What a copy attempt ended as (pt-BR keys). */
const OUTCOME = {
  copied: { label: tk('Copiado ✓'), announced: tk('Mensagem copiada') },
  failed: { label: tk('Não foi possível copiar'), announced: tk('Não foi possível copiar a mensagem') },
} as const;

/**
 * HTML that reads the same whatever charset its reader assumes (TER-1193): it declares UTF-8 and writes
 * every character beyond ASCII as a numeric reference (one per code point, so an emoji is one
 * `&#x1f44b;`, not two surrogates). On iOS, expo-clipboard turns the HTML into rich text from its UTF-8
 * bytes without naming the encoding, and WebKit then reads them as Windows-1252: "👋" pasted as "ðŸ‘‹"
 * and "ç" as "Ã§" in Teams and WhatsApp, rich text and plain alike. Android keeps the string as is.
 */
export function pasteboardHtml(html: string): string {
  let ascii = '';
  for (const char of html) {
    const code = char.codePointAt(0) ?? 0;
    ascii += code > 0x7f ? `&#x${code.toString(16)};` : char;
  }
  return `<meta charset="utf-8">${ascii}`;
}

/**
 * Puts a draft on the clipboard: as HTML where the system takes it (iOS and Android keep a plain
 * version next to it, which Teams and Slack fall back to), else as plain text in Slack's typed Markdown
 * (`draftPlainText`). Throws only when neither worked.
 */
export async function copyDraft(source: string, markdownit: MarkdownIt): Promise<void> {
  try {
    await Clipboard.setStringAsync(pasteboardHtml(markdownit.render(source)), { inputFormat: Clipboard.StringFormat.HTML });
  } catch {
    await Clipboard.setStringAsync(draftPlainText(source));
  }
}

type Props = {
  /** The fence's text as the parser gives it: with the fence's own trailing newline. */
  content: string;
  /** The answer's whole style sheet (the rule's `styles`), so the draft reads like the answer. */
  style: Record<string, unknown>;
  rules: RenderRules;
  markdownit: MarkdownIt;
};

/**
 * A message the concierge wrote for the person to send to someone else (TER-1159), from a ```draft
 * fence: rendered as Markdown in a "Mensagem pronta" card whose always-visible "Copiar" puts it on the
 * clipboard formatted (`copyDraft`), says "Copiado ✓" for a moment and announces it.
 */
export function DraftCard({ content, style, rules, markdownit }: Props): ReactNode {
  useTranslation();
  const source = codeOf(content);
  const [outcome, setOutcome] = useState<keyof typeof OUTCOME | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async () => {
    let next: keyof typeof OUTCOME = 'copied';
    try {
      await copyDraft(source, markdownit);
    } catch {
      next = 'failed';
    }
    setOutcome(next);
    AccessibilityInfo.announceForAccessibility(t(OUTCOME[next].announced));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), COPY_FLASH_MS);
  };
  const copyTone = outcome === 'failed' ? 'text-app-danger' : outcome === 'copied' ? 'text-app-ok' : 'text-app-text';
  return (
    <View className="my-1 overflow-hidden rounded-md border border-app-border">
      <View className="flex-row items-center justify-between border-b border-app-border bg-app-surface2 pl-3 pr-1">
        <Text className="flex-1 text-xs font-medium text-app-muted" numberOfLines={1}>
          {t('Mensagem pronta')}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Copiar mensagem')} onPress={() => void onCopy()} hitSlop={8} className="min-h-[32px] justify-center px-2">
          <Text className={`text-xs ${copyTone}`}>{outcome ? t(OUTCOME[outcome].label) : t('Copiar')}</Text>
        </Pressable>
      </View>
      <View className="px-3 py-1">
        {/* A link in the draft opens in the browser (the rule's own fallback): the fence rule is not
            handed the answer's `onLinkPress`. */}
        <Markdown style={style as never} rules={rules} markdownit={markdownit}>
          {source}
        </Markdown>
      </View>
    </View>
  );
}
