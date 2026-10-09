---
symptom: "expected '<!DOCTYPE html>\\n<html lang=\"pt-BR\">…' to contain 'lang=\"es\"' (and i18n:check: no Spanish (es) entry for …)"
tags: [i18n, email, tests, typecheck, merge]
evidence: fixed
card: TER-745
pr: https://github.com/engenhariainversa/termhub/pull/468
agent: claude
date: 2026-10-09
---
## Cause

A branch changed an e-mail template's signature (`accountDeletedMail(to, opts, locale)`, a new
`opts` before `locale`) and added a pt-BR string with only an `en` catalog entry. Meanwhile `main`
gained the Spanish catalog and a test calling `accountDeletedMail('a@b.c', 'es')` with the old
signature. After merging `main`, `'es'` landed in `opts`, so the mail rendered in pt-BR. The server
`typecheck` does not cover `*.test.ts`, so nothing failed at compile time; only vitest and
`i18n:check` (the missing `es` entry) did.

## Fix

Call the template with the new signature in the test
(`accountDeletedMail('a@b.c', { backupRetentionDays: 30 }, 'es')`) and add the `es` entry to
`apps/server/src/i18n/locales/es/email.json`. When a branch changes a function's parameters and is
merged with a newer `main`, grep every caller, tests included: `grep -rn "fnName(" apps packages`.

## How to check

`npm run i18n:check -w @termhub/server` and, from `apps/server` with any `DATABASE_URL` set
(`config.ts` exits without it), `npx vitest run src/email src/account`.
