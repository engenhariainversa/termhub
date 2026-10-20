# Acceptance of the Terms and the Privacy Policy (TER-742)

Item P-12 of `docs/legal/duvidas-advogado.md`, technical part of TER-717. Today termhub stores nothing about which
version of the Terms of Use or of the Privacy Policy a person accepted.

## What exists today

- There is no open sign-up and no invite-acceptance page. A user row is created by an admin invite
  (`POST /api/users/invite`, `/invite-from-waitlist`), by the CLI, or by the first Google login when
  `AUTH_GOOGLE_SIGNUP=true`. The person then signs in (Google or e-mail code). So "cadastro" and "aceite de convite"
  are the person's **first login**.
- There is no checkout yet (TER-658 / TER-681 are in the backlog).
- The public pages `/termos/` and `/privacidade/` are in draft (PR #283, TER-730); the lawyer review (TER-717) is open.

## Decisions

1. **Nothing changes until a version is registered.** The gate only exists for documents that have a version in
   force in the `legal_document_versions` table. The table ships empty, so this PR changes nothing for anyone until
   the maintainer registers the approved versions (after TER-717 and PR #283).
2. **One acceptance screen covers sign-up, invite and changes.** After login, a person who has not accepted the
   version in force of every document sees a full-screen "Li e aceito os Termos de Uso e a Política de Privacidade"
   with links to both; without ticking it they cannot go on (web and app). For a new user this is the sign-up step;
   for an existing user it is the re-acceptance. Accepting a newer version also satisfies an older one.
3. **Current users (J-3):** by default they see the same screen once, when the first version takes effect (the card's
   "Impact on other users"). If the lawyer asks for something else, it is a change of the screen's copy, not of the
   data model.
4. **API tokens and the MCP keep working** for someone who has not accepted the version in force yet. The gate is in
   the interactive clients (web, app): blocking tokens would silently stop automations and running agents, and the
   person meets the screen on their next visit. Device approval for the app happens in the web, which is gated.
   Revisit if the lawyer requires otherwise.
5. **Relevant vs. minor versions.** A version has `requires_acceptance`. A minor change (typo, contact data) is
   registered with `false`: it is listed, but nobody is asked again. Only versions with `requires_acceptance = true`
   count as "the version in force" for the gate.
6. **30-day notice.** A relevant version that replaces an earlier one must take effect at least 30 days after it is
   registered (the API refuses otherwise). An hourly job e-mails every active user once, as soon as the version is
   within 30 days of taking effect, and the web shows a banner until the date. The first version of a document has no previous
   one to replace, so it may take effect immediately and gets no notice e-mail.
7. **Checkout.** The checkout does not exist yet. The accept endpoint takes `channel: 'checkout'`, and the web
   exports the consent checkbox as a component, so TER-681 records the acceptance with the purchase.

## Data model (additive migration)

```
legal_document_versions
  id                   text pk
  document             text  -- 'terms' | 'privacy'
  version              text  -- as printed in the document ("1", "1.1")
  effective_at         timestamptz
  url                  text  -- public page of that version
  requires_acceptance  boolean default true
  summary              text null  -- what changed (pt-BR), shown in the notice
  notice_sent_at       timestamptz null  -- when the 30-day e-mail went out (claim: set once)
  created_at           timestamptz default now()
  unique (document, version)

legal_acceptances
  id           text pk
  user_id      text fk users on delete cascade
  version_id   text fk legal_document_versions on delete restrict
  accepted_at  timestamptz default now()
  ip           text null
  user_agent   text null
  channel      text  -- 'web' | 'mobile' | 'checkout'
  index (user_id, version_id)
```

Rows are never updated: a new acceptance is a new row (the checkout one stands as evidence of that purchase).

## Server

- `LegalRepository` (`db/repositories/legal.ts`): list/create versions, record acceptances, `statusFor(userId, now)`,
  due-notice claim.
- Status, per document: **pending** = the latest relevant version with `effective_at <= now` when the user has no
  acceptance of it or of a newer version of the same document; **upcoming** = the earliest relevant version with
  `effective_at > now` that the user has not accepted.
- Routes (any signed-in user, not guarded by a resource):
  - `GET /api/legal/status` → `{ pending: LegalVersion[], upcoming: LegalVersion[] }`
  - `POST /api/legal/accept` `{ version_ids: string[], channel?: 'web' | 'checkout' }` → status. Every id must be a
    pending or upcoming version of this user (400 otherwise). IP and user agent come from the request.
  - `GET /api/auth/me` also carries `legal` (the same status) so the web needs no extra request at start-up.
- Admin (`guarded('legal', …, '/legal/versions')`, new resource `legal`, admins only by default):
  - `GET /api/legal/versions`, `POST /api/legal/versions` (zod: document, version, effective_at, url,
    requires_acceptance, summary).
- Mobile: `GET /api/m/v1/legal` and `POST /api/m/v1/legal/accept` (channel always `mobile`).
- Notice job (hourly timer in `app.ts`): claims each due version (`notice_sent_at` set from null in one UPDATE, so
  only one colour sends), e-mails users not pending deletion in their locale with `noticeMail`.

## Web

- `AuthProvider` keeps `legal` from `/auth/me`; `AppShell` shows `LegalAcceptancePage` (full screen, like
  `PendingDeletionPage`) while `legal.pending` is not empty.
- `LegalConsent`: the checkbox with the two links, reused by the acceptance page and, later, the checkout.
- `LegalNoticeBanner`: while `legal.upcoming` is not empty, "Os Termos de Uso mudam em {date}. Ver o que muda", with
  "Li e aceito" to accept early and a close button (remembered per version in localStorage).

## App

- An account-level `legal` store loads `GET /legal` on `sessionStarted` and on foreground; while `pending` is not
  empty, `redirectFor` sends the unlocked session to `/legal-acceptance` (same pattern as the pending deletion,
  TER-720), which shows the checkbox with links and posts the acceptance.

## Impact on other users

None until the maintainer registers the approved versions. From then on, every user (new and current) sees the
acceptance screen once per relevant version, on the web and in the app; minor versions ask nothing. API tokens and the
MCP are not affected. This is the default for everyone, as the law requires; nothing is opt-in.
