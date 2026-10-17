import * as Haptics from 'expo-haptics';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import { Linking, Modal, Pressable, Share, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { MarkdownIt } from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from '@/i18n';
import { canCopy, copyToClipboard } from '@/services/clipboard';
import { Icon, type IconName } from '@/ui';
import { showToast } from '@/ui/toast';
import { firstLink, messageCopyText, type MdParse, type MdToken } from '../model/message-text';
import type { ChatMessage } from '../model/types';

/** The renderer's own parser, set up as `react-native-markdown-display` sets up its default one. */
const markdown = MarkdownIt({ typographer: true });
const parse: MdParse = (text) => markdown.parse(text, {}) as MdToken[];

/** How long a finger rests on a row before the menu opens: iOS's own context-menu delay. */
export const LONG_PRESS_MS = 350;
/** The menu's width, and the height of one of its rows. */
const MENU_WIDTH = 232;
const ROW_HEIGHT = 48;
/** The space between the lifted row and the menu, and between either and the screen's edges. */
const GAP = 8;

const ICON = {
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  reply: { ios: 'arrowshape.turn.up.left', android: 'reply' },
  link: { ios: 'link', android: 'link' },
  open: { ios: 'safari', android: 'open_in_new' },
} satisfies Record<string, IconName>;

type Anchor = { x: number; y: number; width: number; height: number };
type Item = { key: string; label: string; icon: IconName; run(): void };

/**
 * Where the lifted row and the menu stand on a screen of `height` (insets apart): the row where it was,
 * moved only as far as it takes for the menu to fit under it, and cut at the top of the menu when the
 * row is taller than what is left (a long answer).
 */
export function menuLayout(anchor: Anchor, rows: number, height: number, insets: { top: number; bottom: number }) {
  const menuHeight = rows * ROW_HEIGHT;
  const top = insets.top + GAP;
  const bottom = height - insets.bottom - GAP;
  const previewHeight = Math.max(0, Math.min(anchor.height, bottom - top - menuHeight - GAP));
  const previewTop = Math.min(Math.max(anchor.y, top), bottom - menuHeight - GAP - previewHeight);
  return { previewTop, previewHeight, menuTop: previewTop + previewHeight + GAP };
}

type Props = {
  message: Pick<ChatMessage, 'role' | 'text' | 'attachments'>;
  /** "Responder"; absent, the menu does not offer it. */
  onReply?(): void;
  /** Off for a row there is nothing to do with yet (an answer still being written). */
  enabled?: boolean;
  children: ReactNode;
};

/**
 * A touch held on a row of the thread (TER-1090): the row lifts over a dimmed screen with a menu under
 * it, as iMessage and WhatsApp do — "Copiar" (the row as it reads: Markdown turned into plain text,
 * links with their address), "Responder", and for a row with a web address "Copiar link" and "Abrir
 * link". One light haptic tap as it opens. Plain React Native on both systems, so it ships over the air.
 *
 * The clipboard is a native module this binary may not carry yet (`services/clipboard`): without it,
 * "Copiar" is "Compartilhar", the system sheet, which can copy too. A drag on the row is still the
 * list's scroll or the drag to answer: a touch that moves before the delay never opens the menu.
 */
export function MessageMenu({ message, onReply, enabled = true, children }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const row = useRef<View>(null);
  const [shown, setShown] = useState<{ anchor: Anchor; items: Item[] } | null>(null);
  const close = useCallback(() => setShown(null), []);

  // Built when the menu opens, not on every render: a long thread would parse each answer for nothing.
  const itemsOf = useCallback((): Item[] => {
    const text = messageCopyText(message, parse);
    const link = text ? firstLink(text) : null;
    const copyable = canCopy();
    const copy = (value: string) => {
      if (!copyable) return void Share.share({ message: value }).catch(() => undefined);
      void copyToClipboard(value).then((ok) => showToast(ok ? t('Copiado') : t('Não foi possível copiar')));
    };
    const list: Item[] = [];
    if (text) list.push({ key: 'copy', label: copyable ? t('Copiar') : t('Compartilhar'), icon: copyable ? ICON.copy : ICON.share, run: () => copy(text) });
    if (onReply) list.push({ key: 'reply', label: t('Responder'), icon: ICON.reply, run: onReply });
    if (link) {
      list.push({ key: 'copy-link', label: copyable ? t('Copiar link') : t('Compartilhar link'), icon: copyable ? ICON.link : ICON.share, run: () => copy(link) });
      list.push({ key: 'open-link', label: t('Abrir link'), icon: ICON.open, run: () => void Linking.openURL(link).catch(() => undefined) });
    }
    return list;
  }, [message, onReply, t]);

  const open = useCallback(() => {
    if (!enabled) return;
    const items = itemsOf();
    if (items.length === 0) return;
    const lift = (x: number, y: number, width: number, height: number) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      setShown({ anchor: { x, y, width, height }, items });
    };
    if (row.current?.measureInWindow) row.current.measureInWindow(lift);
    else lift(0, 0, window.width, 0);
  }, [enabled, itemsOf, window.width]);

  // Fails as soon as the finger moves: that touch is the list's scroll or the drag to answer.
  const hold = Gesture.LongPress().withTestId('message-menu-hold').enabled(enabled).minDuration(LONG_PRESS_MS).runOnJS(true).onStart(open);

  const anchor = shown?.anchor ?? null;
  const items = shown?.items ?? [];
  const layout = anchor ? menuLayout(anchor, items.length, window.height, insets) : null;
  const mine = message.role === 'user';
  return (
    <>
      {/* A gesture recognizer, not a touchable: the bubble's links and buttons keep their taps, and a tap
          on the bubble still reaches the list (it closes the keyboard) as before. */}
      <GestureDetector gesture={hold}>
        <View ref={row} collapsable={false}>
          {children}
        </View>
      </GestureDetector>
      <Modal testID="message-menu" transparent animationType="fade" visible={anchor !== null} onRequestClose={close} statusBarTranslucent>
        <Pressable testID="message-menu-backdrop" className="absolute inset-0 bg-black/50" onPress={close} accessibilityRole="button" accessibilityLabel={t('Fechar')} />
        {anchor && layout ? (
          <>
            <View pointerEvents="none" style={{ position: 'absolute', left: anchor.x, width: anchor.width, top: layout.previewTop, height: layout.previewHeight, overflow: 'hidden' }}>
              {children}
            </View>
            <View
              accessibilityViewIsModal
              onAccessibilityEscape={close}
              style={[{ position: 'absolute', top: layout.menuTop, width: MENU_WIDTH }, mine ? { right: Math.max(GAP, window.width - anchor.x - anchor.width) } : { left: Math.max(GAP, anchor.x) }]}
              className="overflow-hidden rounded-2xl bg-app-surface"
            >
              {items.map((item, i) => (
                <Fragment key={item.key}>
                  {i > 0 ? <View className="h-px bg-app-border" /> : null}
                  <Pressable
                    accessibilityRole="menuitem"
                    accessibilityLabel={item.label}
                    onPress={() => {
                      close();
                      item.run();
                    }}
                    style={{ height: ROW_HEIGHT - (i > 0 ? 1 : 0) }}
                    className="flex-row items-center justify-between px-4 active:bg-app-surface2"
                  >
                    <Text className="text-base text-app-text">{item.label}</Text>
                    <Icon name={item.icon} size={18} tone="text" />
                  </Pressable>
                </Fragment>
              ))}
            </View>
          </>
        ) : null}
      </Modal>
    </>
  );
}
