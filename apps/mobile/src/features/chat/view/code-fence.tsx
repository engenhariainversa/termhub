import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { RenderRules } from 'react-native-markdown-display';
import { t } from '@/i18n';
import { codeFileExtension, codeFileName, fenceLanguage } from '../model/code-file';
import { saveCodeFile } from '../viewmodel/code-file-save';

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
 * A code block of an answer (TER-1084): the library's own fence look, under a header with the language
 * and "Baixar", which saves exactly the block's text as a file (`saveCodeFile`). Inline code is not a
 * fence and never gets one. Always visible: a phone has no hover.
 */
export function CodeFence({ content, info, style, save = saveCodeFile }: Props): ReactNode {
  const language = fenceLanguage(info);
  // The parser sends one newline too many at the end (the library trims it the same way to show it);
  // the file keeps the block's own last line break.
  const shown = content.endsWith('\n') ? content.slice(0, -1) : content;
  const onSave = () => {
    const ext = codeFileExtension(language);
    void save(codeFileName(content, language), content, ext).catch(() => undefined);
  };
  return (
    <View className="my-1 overflow-hidden rounded-md border border-app-border">
      <View className="flex-row items-center justify-between border-b border-app-border bg-app-surface2 px-3">
        <Text className="text-[11px] uppercase tracking-wide text-app-muted">{language ?? t('código')}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Baixar como arquivo')} onPress={onSave} hitSlop={8} className="min-h-[32px] justify-center px-2">
          <Text className="text-xs text-app-muted">{t('Baixar')}</Text>
        </Pressable>
      </View>
      <Text style={[style, { borderWidth: 0, borderRadius: 0, marginBottom: 0 }]}>{shown}</Text>
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
