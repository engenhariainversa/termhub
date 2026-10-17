import { Linking, Share, Text } from 'react-native';
import { MarkdownIt, type RenderRules } from 'react-native-markdown-display';
import { isWebUrl } from '../model/links';
import { codeFenceRules } from './code-fence';

/**
 * The answers' parser (TER-1089): the library's default (`typographer`) plus `linkify`, so a bare
 * http(s) URL becomes a link, its final full stop or closing parenthesis left out. Only http(s): no
 * schemeless `termhub.dev`, e-mail, `ftp:` or `//host`. Code (inline or fenced) is never linkified.
 * One instance for every bubble: the library would otherwise build a new parser on each render.
 */
export const chatMarkdownIt = MarkdownIt({ typographer: true, linkify: true });
chatMarkdownIt.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
chatMarkdownIt.linkify.add('ftp:', null).add('mailto:', null).add('//', null);

/** Opens a link of a message in the system's browser. Anything but http(s) stays put. */
export function openWebLink(url: string): void {
  if (isWebUrl(url)) void Linking.openURL(url).catch(() => undefined);
}

/** A long press on a link: the system's share sheet with the URL, which offers "Copiar" on iOS and
 *  Android (the app has no clipboard module, and adding one is a new store build). */
export function shareLink(url: string): void {
  if (isWebUrl(url)) void Share.share({ message: url }).catch(() => undefined);
}

/** The answers' rules: the code fences' (`codeFenceRules`), and a link that a long press shares. A tap
 *  asks `onLinkPress` first (a Markdown path opens its preview) and opens only an http(s) URL itself. */
export const chatMarkdownRules: RenderRules = {
  ...codeFenceRules,
  link: (node, children, _parent, styles, onLinkPress) => {
    const href = String(node.attributes.href ?? '');
    return (
      <Text
        key={node.key}
        style={styles.link}
        accessibilityRole="link"
        onPress={() => {
          if (onLinkPress?.(href) ?? true) openWebLink(href);
        }}
        onLongPress={isWebUrl(href) ? () => shareLink(href) : undefined}
      >
        {children}
      </Text>
    );
  },
};
