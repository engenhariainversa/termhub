# TER-368 spike: hardware-keyboard Enter in the composer (throwaway)

Question: with the composer focused on iPadOS, can a hardware-keyboard Enter send the message and
Shift+Enter insert a new line, without touching the on-screen keyboard's Return?

Approach under test: a local Expo module view (`KeyCommandsView`) wraps the composer's `TextInput`.
While the text view inside it is first responder, UIKit asks it for `keyCommands`; it returns
Return and Cmd+Return with `wantsPriorityOverSystemBehavior = true`, so UITextView does not insert
"\n" first. Shift+Return is not claimed. The on-screen keyboard never goes through UIKeyCommand.

Rejected without building (source read on jarvis):
- react-native-external-keyboard 1.2.0: detects Enter without Shift in `pressesBegan` but always
  calls super, so the new line is still inserted; it also swizzles UIViewController, scroll views
  and RN component views app-wide.
- react-native-key-command 1.0.18: a global list that must be returned from the AppDelegate's
  `keyCommands`, without priority over a focused text view, so Return never reaches it.

## Run it (Mac)

    git fetch origin && git checkout spike/ter-368-key-commands
    npm ci && npm run build:contract -w @termhub/mobile
    npx expo prebuild --platform ios --clean     # from apps/mobile
    npm run ios -w @termhub/mobile -- --device "iPad Pro 13-inch (M4)"

Simulator: I/O → Keyboard → Connect Hardware Keyboard (⇧⌘K). Open a chat and focus the composer.
Metro prints `[TER-368 spike] submit key none|command` on every claimed key.

## Cases (expected)

1. Hardware Enter with text → sends; the box empties; no stray "\n" left behind.
2. Hardware Shift+Enter → new line at the caret; nothing sent.
3. Cmd+Enter → sends.
4. On-screen keyboard Return (disconnect the hardware keyboard, ⇧⌘K) → new line; nothing sent.
5. Enter with an empty box → nothing sent, no new line.
6. Japanese IME (Kana) composing, Enter → confirms the composition; nothing sent.
7. Enter while an attachment is still uploading → nothing sent, text kept (same rule as ↑).
8. Focus another TextInput (e.g. a tab-question card's field) → Enter there behaves as before.
9. iPhone with a Bluetooth keyboard (optional) → same as 1–3.

Record the result of each case on TER-369.
