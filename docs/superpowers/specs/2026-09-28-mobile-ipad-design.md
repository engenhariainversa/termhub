# Mobile app on the iPad (TER-312)

Date: 2026-09-28. Card: TER-312 ("App mobile: suporte a iPad"). Related: TER-104 (the local TestFlight build on the Mac), TER-98 (chat redesign), TER-276 (composer).

## 1. Goal

The termhub app (`apps/mobile`, Expo 57, RN 0.86, NativeWind 4) ships today as an iPhone-only binary (`ios.supportsTablet: false`): on an iPad it runs in the scaled iPhone frame. The goal is a universal build (iPhone + iPad) whose screens use the iPad's width, rotate, and survive Split View / Slide Over, published through the existing TestFlight flow of TER-104 (the Mac "capitão américa", no EAS).

Success:

- `app.json` produces a universal binary that App Store Connect accepts (no ITMS-90474 orientation error).
- On a wide window the Chats tab shows the list and the open conversation side by side; on a narrow one (iPhone, Slide Over, a narrow Split View) the app behaves exactly as today.
- Text-heavy screens never stretch past a readable width.
- Jest covers the wide layout (iPad width) and the narrow one (iPhone width), plus the config that makes the build universal.

## 2. Decisions

### 2.1 `supportsTablet: true`, no `requireFullScreen`

`ios.supportsTablet` becomes `true`; `ios.requireFullScreen` stays unset (false). Reason: with tablet support on and full screen not required, Expo's `withRequiresFullScreen` plugin (`@expo/config-plugins/build/ios/RequiresFullScreen.js`) writes all four orientations into `UISupportedInterfaceOrientations~ipad` and sets `UIRequiresFullScreen = false`. That is exactly what iPad multitasking (Split View, Slide Over, Stage Manager) requires, and it is what App Store validation checks (ITMS-90474). Requiring full screen would avoid the multitasking sizes but make the app the only one on iPad that cannot share the screen with a terminal or the browser, which is how this app is meant to be used next to work.

### 2.2 Orientation: iPhone stays portrait, iPad rotates freely

`expo.orientation` stays `"portrait"`. It only writes `UISupportedInterfaceOrientations` (the iPhone key); the iPad key comes from §2.1 with all four. Reason: the iPhone layouts are designed for portrait (the composer, the sheets) and nobody asked for landscape there; on the iPad every orientation is mandatory anyway once multitasking is on. No `expo-screen-orientation`, no runtime locking. The layout reacts to the window size (§2.3), not to the orientation, so rotation, Split View resizing and Stage Manager all go through the same path.

### 2.3 Wide layout: list + conversation side by side in the Chats tab

A window is **wide** when its width is at least **700 pt** (`WIDE_MIN_WIDTH`). Reason: the smallest iPad in portrait (iPad mini, 744 pt) gets the split; a 50/50 Split View on an 11" iPad in landscape (~590 pt), Slide Over (320 pt) and every iPhone (≤ 440 pt, portrait only) stay compact. At 700 pt a 320 pt list leaves 380 pt for the conversation, the width of a small iPhone.

On a wide window the Chats tab renders two panes:

- **Left (320 pt)**: the same list as today (Chat geral, then the projects), with the selected row highlighted (`accessibilityState.selected`). Tapping a row selects it instead of pushing `/chat/<id>`.
- **Right (the rest)**: the selected conversation, embedded: the same view as the `/chat/[id]` route, minus the "Voltar" button. With nothing selected, an empty state ("Escolha uma conversa" / "Selecione um chat na lista ao lado.").

Why a split rather than only centring the phone layout: the value of the app on the iPad is keeping an eye on several projects' chats (busy, pending confirmations) while answering one; the split shows the list's live state next to the thread with no back-and-forth. Why not a native `UISplitViewController` or an expo-router drawer/layout change: the tabs and the stack are shared with the phone, a route-level restructuring would touch deep links (`termhub://chat/<id>`), the unlock redirect and the notification taps, and none of that needs to change. The split lives inside one screen and is driven only by the window width.

Details:

- The selection is local state of the Chats screen. Collapsing to compact (Split View narrowed, rotation on the mini) shows the list only and keeps the selection; widening again restores the pane. No automatic push on collapse (a push while another tab is focused would yank the person there).
- The chat store holds one active conversation. A deep link or a notification tap still pushes `/chat/<id>` full screen on the iPad (unchanged); when the Chats tab regains focus, it re-opens its selected route, so the pane never shows the conversation the pushed screen left active.
- The tab bar stays; on the iPad React Navigation already lays the labels beside the icons.
- Crossing 700 pt (dragging the Split View divider, rotating the mini) remounts the pane: an unsent draft and its attachment chips are lost, and the list scrolls back to the top. Known and accepted for now; keeping them would mean lifting the composer's state out of the conversation view.

### 2.4 Readable width everywhere else

`MAX_READABLE_WIDTH = 720`. Reason: past ~720 pt lines of chat text and forms become hard to read and buttons float far apart; 720 is roughly the web app's centred content width and fits a Split View half exactly.

- `Screen` gets a `width` prop: `'readable'` (default) centres its content at 720 pt max; `'full'` keeps today's full width. Chats uses `'full'` (the split handles its own widths); the conversation uses `'full'` for its header and constrains its own thread and composer.
- In the conversation, the thread (`FlatList` content container) and the composer are centred at 720 pt max. Bubbles keep their percentage max widths (85% / 92%), now of that column.
- `Sheet` (the bottom sheets: Nova conversa, PIN, host, subagents) is centred at 560 pt max instead of spanning a 1366 pt screen.
- On an iPhone nothing changes: every width there is already under the limits.

### 2.5 Hardware keyboard: out of this card, follow-up

> Done in TER-368 (app 0.7.0): a local Expo module, `apps/mobile/modules/key-commands`, claims Return and ⌘Return with a `UIKeyCommand` while the composer has the focus. See the mobile README, "iPad".

The card asks for "Enter envia, Shift+Enter quebra linha" on a hardware keyboard. RN 0.86's `TextInput` cannot tell them apart: `onKeyPress` carries only `key` (no modifiers), and `submitBehavior="submit"` turns *every* Return into a send, Shift+Return and the on-screen keyboard's Return included, so a multi-line message would become impossible on the iPad. Doing it right needs a native `UIKeyCommand` (a local Expo module, or a library such as `react-native-key-command`), which cannot be built or tested from jarvis (no Mac, no Xcode) and would ride blind into the TestFlight build TER-104 is waiting on. Decision: the composer keeps Return = new line and ↑ = send on every device; the hardware-keyboard shortcut becomes a follow-up recorded on the card, to be done on the Mac where it can be built and tried. Typing, arrows, Cmd+A/C/V/Z and dictation already work on a hardware keyboard through the stock `TextInput`.

### 2.6 Pointer / trackpad

No code. Taps, scrolling (two-finger), text selection and the context menu come from UIKit for free; RN has no stable per-component hover effect on iOS, and adding one is cosmetic. Recorded for the manual check (§5).

### 2.7 Native modules, icons, launch screen

No code, manual check only (§5):

- Device key (Secure Enclave via `@pagopa/io-react-native-crypto`), PIN vault (SecureStore) and biometrics (`expo-local-authentication`: Face ID on the iPad Pro, Touch ID on the others; `NSFaceIDUsageDescription` is already set) work the same on the iPad.
- Audio (`expo-audio`), photos/camera (`expo-image-picker`: on the iPad the library opens as a popover) and files (`expo-document-picker`) have no iPad-specific setup.
- The icon is a single 1024 px image: Xcode's single-size app icon covers the iPad sizes. The launch screen is `expo-splash-screen`'s storyboard, centred on any size.
- iPad screenshots are only needed for an App Store listing; TestFlight does not require them. Not in this card.

## 3. Units

| Unit | Where | Purpose |
|---|---|---|
| `isWide(width)`, `WIDE_MIN_WIDTH`, `MAX_READABLE_WIDTH`, `SPLIT_LIST_WIDTH`, `SHEET_MAX_WIDTH` | `src/ui/layout.ts` (pure, no RN import) | the breakpoint and the widths, unit-tested in the `logic` project |
| `useWideLayout()` | `src/ui/use-wide-layout.ts` | `isWide(useWindowDimensions().width)`: follows rotation and multitasking resizes |
| `Screen` `width` prop | `src/ui/screen.tsx` | readable column by default, `'full'` opt-out |
| `Sheet` max width | `src/ui/sheet.tsx` | centred panel on wide windows |
| `ConversationView({ routeId, embedded })` | `src/features/chat/view/conversation-screen.tsx` | today's screen body, parameterised; `ConversationScreen` (the route) renders it with the route param |
| Chats split | `src/features/chat/view/chats-screen.tsx` | compact: today's list and push; wide: list pane + `ConversationView embedded` |
| `app.json` | `apps/mobile/app.json` | `supportsTablet: true` |

## 4. Tests (Jest)

- `logic`: `isWide` at 390, 699, 700, 744, 1024; `app.json` has `ios.supportsTablet === true`, no `requireFullScreen`, `orientation === 'portrait'`.
- `ui`, with `useWindowDimensions` mocked to an iPad (1024 × 768) or an iPhone (390 × 844):
  - Chats wide: list + "Escolha uma conversa"; a row tap shows the conversation in the pane (the seeded message appears), marks the row selected, and does not call `router.push`; no "Voltar".
  - Chats wide → compact (rerender at 390): the list only; back to wide: the selected conversation again.
  - Chats compact: today's push (the existing tests, unchanged).
  - Conversation embedded: no "Voltar"; the thread and composer columns carry `maxWidth: 720`.
  - `Screen` default carries `maxWidth: 720`; `width="full"` does not. `Sheet` panel carries `maxWidth: 560`.

## 5. Manual check (on the Mac, iPad simulator or device)

1. Build universal (TER-104 flow) and install on an iPad (or the "iPad (A16)" / "iPad Pro 13-inch" simulator).
2. Enrol / unlock with PIN and biometrics; run "Diagnóstico da chave".
3. Chats in portrait and landscape: split appears, selecting switches the pane, sending works, the composer sits on the keyboard (software and hardware).
4. Split View 50/50 and Slide Over: the app goes compact (list → push), and back to the split when widened.
5. Attachments: photo (popover), camera, file, audio recording, dictation.
6. Sheets centred; Ajustes, Notificações and Progresso in a readable column.
7. Trackpad: taps, scrolling, selecting text in a bubble.
8. In Slide Over, Stage Manager and with the floating iPad keyboard: focus the composer and open the PIN sheet; both must sit on the keyboard (RN's `KeyboardAvoidingView` compares screen and window coordinates, and off the screen origin they may float or hide).
9. Drag the Split View divider across 700 pt with a draft and an attachment chip in the composer: the pane remounts, the draft and the chips are lost and the list scrolls back to the top (known, §2.3) — nothing else breaks.
10. A build from an `ios/` folder generated before this change stays iPhone-only: re-run `npx expo prebuild --clean` first.

## 6. Out of scope

- Enter-to-send / Shift+Enter on a hardware keyboard (§2.5, follow-up).
- Landscape on the iPhone.
- Hover effects, drag and drop of files into the composer, multiple windows (scenes).
- App Store listing and iPad screenshots.
