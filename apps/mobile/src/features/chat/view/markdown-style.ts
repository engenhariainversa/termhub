// The style `react-native-markdown-display` gets (chat redesign spec §4.2 "Markdown"): one object
// per colour scheme, built once at module load. The bubble used to build a fresh object on every
// render, which made the renderer restyle every node of the answer on every delta.
import { tokens, type SchemeName } from '@/theme/tokens';

function styleFor(scheme: SchemeName) {
  const palette = tokens[scheme];
  return {
    body: { color: palette.text, fontSize: 16 },
    code_inline: { backgroundColor: palette.surface2, color: palette.text },
    fence: { backgroundColor: palette.surface2, color: palette.text, borderColor: palette.border },
    link: { color: palette.accent },
  };
}

export type MarkdownStyle = ReturnType<typeof styleFor>;

const STYLES: Record<SchemeName, MarkdownStyle> = { dark: styleFor('dark'), light: styleFor('light') };

export const markdownStyle = (scheme: SchemeName): MarkdownStyle => STYLES[scheme];
