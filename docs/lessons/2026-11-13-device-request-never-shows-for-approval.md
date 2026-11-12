---
symptom: "The app shows \"Waiting for approval\" with a code, but no request appears on the web (no \"Um aparelho pede acesso à sua conta\" banner, nothing in Configurações › Aparelhos)"
tags: [mobile, enrolment, simulator, devices]
evidence: observed
card: TER-1162
agent: claude
date: 2026-11-13
---
## Cause

The e-mail typed in the app is not the e-mail of any termhub account. To not leak which e-mails have accounts,
`EnrolmentService.request` (`apps/server/src/mobile/enrolment.ts`) answers every request the same way, with a
real-looking code. When the e-mail is unknown, the request is a decoy row (`user_id: null`). The same happens
when the account lacks `devices:create` or already has too many pending requests. A decoy never reaches
anyone's approval screen and simply expires. An agent that guesses the person's login e-mail (from git, from
the Claude account) lands here. Neither of those e-mails has to match the termhub login.

## Fix

Use the e-mail the person signs in to termhub with. Ask for it; do not guess it. For a store review or a demo,
use the review account: an admin turns on "Modo revisão" for it in Configurações › Usuários, and its device
requests are then approved automatically. It only sees its own machines and projects.

## How to check

An admin can look the e-mail up with the MCP `admin_user_troubleshoot` (`endpoint: search`): an empty
`users` list means no account has that e-mail, so the request was a decoy. After a fresh request with the
right e-mail, the banner shows on the web within seconds.
