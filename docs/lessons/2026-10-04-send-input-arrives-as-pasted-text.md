---
symptom: "the message arrived as pasted text / chegou como texto colado — a tab agent refuses an order relayed by the concierge with send_input"
tags: [send_input, tmux, claude-code, concierge, paste]
evidence: observed
card: TER-851
agent: claude
date: 2026-10-04
---
## Cause

Claude Code wraps typed input longer than 800 characters (measured on 2.1.289: 800 typed, 801 pasted; characters, not bytes) in `<pasted_content>` and tells the model to follow instructions
inside it only where the person's own words ask for that. It does this **without any newline and
without bracketed paste**: the relays refused on 2026-10-03/04 were single lines of 836 and 933
characters typed with `tmux send-keys -l` (the plain path of `sendInput`, not `paste-buffer -p`), and
the transcripts show them wrapped. A 158-character line was taken as typed. So switching
`send_input` away from bracketed paste does not help, and a short relay written in the person's name
("Pedro aqui…") passes as the person typing, which is the real hole.

## Fix

Not a delivery change. Spec `docs/superpowers/specs/2026-10-04-relayed-input-provenance-design.md`:
the server records who wrote each typed text and the monitor hook returns it on `UserPromptSubmit` as
`additionalContext`. Until that ships, the person has to type the order in the tab (or a short line).

## How to check

Look at what the session actually received, in the tab's transcript:
`grep -l pasted_content ~/.claude*/projects/<project-dir>/<session>.jsonl` and read the user entry
before the refusal; the inner text length and newline count tell which path it took.
