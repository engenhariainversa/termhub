# Spike: corporate SSO (OIDC/SAML), SCIM and MFA for termhub Cloud (TER-581)

Origin TER-543, written on 2026-10-07 against `main` at `c6ed07b2`. A research document: no code
changes. It answers the four questions of the card and ends with a phased recommendation and an
estimate per phase. The proposed cards (section 8) are **not created yet**: they are listed here
for the maintainer to review first.

## 1. Summary

| Question | Short answer |
| --- | --- |
| Does generic OIDC (Okta, Entra ID, Google Workspace) cover most companies? | **Yes.** Every mainstream IdP speaks OIDC. SAML is a procurement checkbox more than a technical need; build it only when a paying customer asks, or buy it through a broker. |
| Does Cloudflare Access with the company's IdP already cover the Cloud? | **For a self-hosted instance, yes, today.** For the shared Cloud (`app.termhub.dev`), **no**: it is one Access application in termhub's own Zero Trust account, with an e-mail allowlist, and it does not reach the phone app or the machine agents. It stays the alpha's perimeter, not the enterprise product. |
| Passkeys as a second factor? | **Yes, and also as a first factor.** WebAuthn passkeys for sign-in, and as the required second factor after a password; TOTP as the fallback; recovery codes. SSO users get their MFA from the IdP, not from termhub. |
| What does SCIM deprovisioning cost? | **About 6 to 8 days for SCIM Users, on top of a "deactivate user" primitive (4 to 5 days)** that termhub needs anyway. Most of the revocation already exists (the pending-deletion gate); the gaps are live sockets, machine agents and automatic runs. |

The real blocker for "SSO in the Cloud" is not OIDC: it is that **the Cloud has no organization
(tenant)**. Roles are instance-wide, and a company's IdP, its verified domain, its SCIM token and
its own administrators all need an organization to hang from (section 6).

## 2. What exists today

Read from the code, so the estimates below start from the right place:

- **Sign-in methods** (`apps/server/src/auth/`): e-mail + 6-digit code (`service.ts`, rate-limited,
  per-e-mail and per-IP lockout), password (argon2id, `password.ts`), Google OAuth (`google.ts`:
  authorization code + PKCE, `id_token` checked against Google's JWKS with `jose`; links by
  verified e-mail; creates accounts only with `AUTH_GOOGLE_SIGNUP=true`), and Cloudflare Access
  (`cloudflare.ts`: verifies `cf-access-jwt-assertion` against the team's JWKS and finds the user
  by e-mail, no JIT creation). `AUTH_MODE` combines `app` and `cloudflare`; with both, the two
  identities must match (`middleware.ts`).
- **Credentials a person holds**: web sessions (`Session`, opaque token, hash in the DB), API
  tokens (`ApiToken`, also the MCP's bearer and the per-tab tokens), phone devices (`Device` /
  `DeviceToken`, enrolled through a `DeviceRequest` that a signed-in account approves), and
  machines (`Machine.agentTokenHash`, the agent's enrollment token).
- **A deactivation gate already exists**, built for self-service deletion (TER-720):
  `isPendingDeletion(user)` is checked by the web auth hook, the web WebSocket upgrade
  (`ws/router.ts`), the MCP/API token check (`mcp/auth.ts`), the mobile API and mobile WebSocket
  (`mobile/auth.ts`, `mobile/ws-auth.ts`) and push. Requesting a deletion deletes every web
  session. Deleting the account removes the e-mail from the Cloudflare Access allowlist and hangs up
  the machines' agents.
- **Secrets at rest**: `lib/crypto.ts` (AES-256-GCM with `ENCRYPTION_KEY`) already encrypts
  integration tokens; an IdP client secret fits there.
- **Tenancy**: none. `Role` and `isAdmin` are instance-wide; data is scoped by `owner_id`
  (`auth/scope.ts`), i.e. per person, not per company. The Cloud is one instance, gated by a
  Cloudflare Access e-mail allowlist that invites keep in sync (`cloudflare/access.ts`).
- **No** SAML, generic OIDC, SCIM, TOTP or WebAuthn anywhere (confirmed with a search for
  `saml|scim|oidc|totp|webauthn|passkey|mfa`).

## 3. Generic OIDC: does it cover most companies?

**Yes.** Okta, Microsoft Entra ID, Google Workspace, Auth0, Keycloak, JumpCloud, OneLogin, Ping and
AD FS (2016 and later) all act as OpenID Connect providers with discovery
(`/.well-known/openid-configuration`). termhub's likely buyers — software teams in startups and
mid-size companies, many in Brazil on Google Workspace or Microsoft 365 — are all on one of them.
SAML-only shops are mostly older on-premises AD FS or large regulated companies, and those buyers
also ask for things termhub does not have yet (audit export, data residency, a contract).

`google.ts` is already an OIDC authorization-code flow with PKCE; generalising it is mostly
replacing the hard-coded URLs with discovery and the hard-coded issuer with the configured one.
Points the implementation must get right:

- **Identity key is `(issuer, sub)`, never the e-mail.** A new `user_identities` table
  (`user_id`, `issuer`, `subject`, `email_at_link`) replaces the single `users.google_id` column
  over time; Google becomes one more row.
- **Linking to an existing account by e-mail only when it is safe**: `email_verified === true`
  *and* (in the Cloud) the e-mail's domain is a domain the organization verified. Entra ID in
  particular does not guarantee `email` is verified; for Entra, use `oid`/`sub` with `tid` and
  check the tenant.
- **Multi-tenant issuers** (Entra's `common` endpoint) are refused: each connection pins one
  issuer.
- **Just-in-time provisioning** with the connection's default role, as `AUTH_GOOGLE_SIGNUP` does
  today, off by default.
- **SSO enforcement**: when a connection is "required" for a domain, password and e-mail-code
  sign-in are refused for those accounts (the e-mail code would otherwise bypass the IdP's MFA and
  its offboarding).
- PKCE, `state`, `nonce`; `jose` is already a dependency, so no new library is strictly needed
  (`openid-client` is an option if discovery and refresh grow).

**SAML**: build only on demand. Two paths, decided when the first customer asks:
(a) `@node-saml/node-saml` in-house, 5 to 8 days including signature/clock-skew hardening and
tests against Okta and Entra; (b) a broker (WorkOS, Auth0/Okta CIC, or a self-run Keycloak) that
speaks SAML to the customer and OIDC to termhub, which needs no SAML code at all but adds a vendor
billed per connection, or a service to operate. Recommendation: (b) with a self-run Keycloak is
not worth it for one customer; prefer (a) or a hosted broker when the deal pays for it.

## 4. Cloudflare Access with the company's IdP

Cloudflare Access can use Okta, Entra ID, Google Workspace, any OIDC or SAML IdP as its login
method, and enforces the IdP's MFA. termhub already trusts the Access JWT (`AUTH_MODE=cloudflare`).

**Self-hosted instance: covered today.** A company that runs termhub on its own infrastructure
can put it behind its own Cloudflare Zero Trust team with its IdP and set
`AUTH_MODE=cloudflare` (or `app,cloudflare`). Gaps, all small:

- no just-in-time creation: the user must exist in termhub first (an invite);
- deprovisioning in the IdP stops new Access logins, but termhub sessions, API tokens, phone
  devices and machines keep working until someone deletes the user in termhub;
- the phone app, the MCP and the machine agents authenticate with their own tokens, not the
  Access JWT (in production `/mcp` is forwarded outside Access and the agent WebSocket has an
  Access bypass), so they are outside the IdP's control.

The cheapest useful step is a README section describing this setup (half a day), and optionally
JIT creation from the Access JWT behind an opt-in flag (1 day).

**Shared Cloud (`app.termhub.dev`): not covered.** Reasons:

- There is one Access application in **termhub's** Zero Trust account, with one e-mail allowlist
  policy that invites maintain. Adding a customer's IdP means adding it to termhub's account by
  hand, and every customer's users then pass through the same team; one customer's IdP could
  vouch for any e-mail it likes, and termhub matches users by e-mail.
- Per-customer hostnames (`acme.termhub.dev`, one Access app each) would isolate them, but still
  by hand, still in termhub's account, with Zero Trust seats (free up to 50 users at the time of
  writing, paid per user after that) billed to termhub for its customers' people.
- It does not cover the phone app, the MCP nor the agents, and it brings no SCIM into termhub.

So Access stays what it is: the perimeter of the alpha. The enterprise answer in the Cloud is
termhub's own OIDC per organization (section 6).

## 5. MFA: passkeys as the second factor

Today the strongest factor is the password (or the mailbox, for the e-mail code). Recommendation:

- **WebAuthn passkeys** (`@simplewebauthn/server` and `@simplewebauthn/browser`), RP ID
  `app.termhub.dev` (or the instance's host, from `config.publicUrl`). Two uses:
  1. *Passwordless sign-in*: "Entrar com passkey", discoverable credentials. Phishing-resistant,
     and the friendliest flow on a Mac or a phone browser.
  2. *Second factor*: after a correct password or e-mail code, an account with a passkey (or with
     MFA required) must present it before the session is created.
- **TOTP** as the fallback for people without a platform authenticator (`otplib`; secret
  encrypted with `lib/crypto.ts`), plus **10 one-time recovery codes** (hashed).
- **Enforcement setting**: per instance (and later per organization), "Exigir segundo fator",
  default off. Admins can reset a user's factors.
- **SSO users**: MFA belongs to the IdP. Accounts that sign in through a required OIDC connection
  skip termhub's second factor (otherwise they get prompted twice).
- **Phone app**: no change. Devices are enrolled through a `DeviceRequest` approved from a signed-in
  account, so the phone inherits whatever factor that sign-in required. Native passkeys on the app
  are not needed for this.
- **Agents and API tokens**: no change (they are not interactive sign-ins); creating an API token
  should require a recent second factor ("step-up", re-check within the last 10 minutes).

## 6. The real prerequisite: organizations in the Cloud

For SSO and SCIM to be safe in a shared instance, each company needs:

- an **organization** with members and its own administrators, who manage only their members —
  today `isAdmin` is instance-wide, so a company admin would be an admin of every Cloud user;
- **verified domains** (DNS TXT record), so a company can only claim and enforce SSO on its own
  e-mails;
- one **OIDC connection** (issuer, client id, encrypted client secret, default role, "required"
  flag) and one **SCIM token** per organization;
- data that belongs to the company rather than to the person (projects, machines, integrations),
  so that offboarding someone transfers their work instead of deleting it.

That is a tenancy change touching `auth/scope.ts`, `auth/permissions.ts`, roles and every
`owner_id` rule, and a product decision (is there a "termhub para empresas" plan? the current
plans are personal: R$ 49,90 and R$ 129,90 per month). It deserves its own design spike, not an
estimate buried in this one. Rough order of magnitude: **15 to 25 days**.

Until then, everything below can be built **per instance** (configured by environment or by the
instance admin), which already serves self-hosted companies and the maintainer's own Cloud, and
moves into organizations later without rework of the protocol code.

## 7. SCIM: the cost of deprovisioning

### 7.1 The protocol

SCIM 2.0 (RFC 7643/7644) under `/scim/v2`, bearer token (a new API token kind, hashed like the
others, scope `scim`), routes registered through `guarded()` like every other plugin:

- `GET /Users?filter=userName eq "…"`, `GET /Users/:id`, `POST /Users`, `PUT /Users/:id`,
  `PATCH /Users/:id` (Okta and Entra both deactivate through `PATCH active=false`; Entra sends
  `"False"` as a string and `op: "Replace"` capitalised), `DELETE /Users/:id`;
  `ServiceProviderConfig`, `ResourceTypes` and `Schemas` discovery endpoints.
- `externalId` stored per identity; `userName` is the e-mail.
- **Groups** (optional, phase 2): IdP group → termhub role. 2 to 3 more days.
- Test against Okta's SCIM validator (Runscope suite) and Entra's provisioning tester; both have
  quirks that only show up there.

Estimate: **6 to 8 days** for Users, including both validators.

### 7.2 What "deprovision" must revoke, and what is already there

A SCIM `active=false` (or `DELETE`, which termhub should treat as deactivation, not deletion) maps
to a new `users.deactivated_at`, distinct from the pending deletion (no 30-day clock, no e-mail to
the person, only an admin or the IdP reactivates). Generalise `isPendingDeletion` into
`isDeactivated(user)` that is true for either.

| Credential | Today on pending deletion | Needed for deprovisioning |
| --- | --- | --- |
| Web sessions | Deleted (`sessions.deleteAllForUser`) | Same |
| New web/mobile WebSocket upgrades | Refused | Same |
| **Already-open** web and mobile WebSockets | **Stay open** | Close them: the hubs need a "disconnect user" call (as `disconnectMachine` for agents) |
| API / MCP / tab tokens | Refused while pending | Same; also stop the tab tokens' automatic runs (below) |
| Phone devices | Refused while pending, no push | Same |
| **Machine agents** (`agent/ws.ts`) | **Not checked**: the agent of a deactivated owner keeps connecting and serving tabs | Refuse the upgrade when the owner is deactivated and hang up the connected agent; tmux sessions on the machine are left alone (they are on the company's computer, and terminal content is never touched) |
| **Automatic runs** (agentic board) | Not stopped | Pause the user's automation (`automationPausedAt`) and stop running runs |
| Cloudflare Access allowlist | Removed only on final deletion | Remove on deactivation, add back on reactivation |
| Owned data | Deleted after 30 days | Kept; admin transfers ownership of projects/machines/integrations to another member (needs §6 to be complete in the Cloud; per instance, admin-only) |

The two **bold** rows are gaps today even for self-service deletion; worth fixing regardless.

Estimate for the deactivation primitive (column, gate, socket close, agent refusal, automation
stop, Access sync, admin "Desativar usuário" button in Settings → Usuários, tests):
**4 to 5 days**. Ownership transfer: **2 to 3 days** more.

## 8. Recommendation and estimate

Order matters: each phase ships on its own and is useful without the next.

| Phase | What | Estimate | Proposed card |
| --- | --- | --- | --- |
| P0 | README: self-hosting behind Cloudflare Access with your IdP (and its gaps); optional JIT from the Access JWT behind a flag | 0.5 + 1 d | "Docs: SSO corporativo via Cloudflare Access em instância própria" |
| P1 | Deactivate user: `deactivated_at`, close open sockets, refuse/hang up agents, stop automation, Access sync, admin button | 4–5 d | "Desativar usuário (revoga sessões, tokens, aparelhos e máquinas)" |
| P2 | MFA: passkeys (sign-in + second factor), TOTP fallback, recovery codes, "exigir segundo fator" per instance, step-up for API tokens | 6–8 d | "Passkeys e segundo fator (TOTP + códigos de recuperação)" |
| P3 | Generic OIDC per instance: discovery, `user_identities`, safe linking, JIT opt-in, "SSO obrigatório"; Google moves onto it | 4–5 d | "Login OIDC genérico (Okta, Entra ID, Google Workspace)" |
| P4 | SCIM 2.0 Users per instance, on top of P1 and P3; Groups → roles later (+2–3 d) | 6–8 d | "SCIM 2.0: provisionar e desprovisionar usuários" |
| P5 | Organizations in the Cloud (tenancy, verified domains, org admins, per-org OIDC and SCIM) | spike first; 15–25 d | "Spike: organizações (multi-tenant) no termhub Cloud" |
| P6 | SAML, only when a customer asks | 5–8 d, or a broker | none until then |

P0–P4 per instance: **about 21 to 28 days**. P5 is the decision that turns this into a Cloud
enterprise offer, and depends on a business plan for companies that does not exist yet.

Suggested start: **P1 now** (it closes two real revocation gaps for any admin, independent of
SSO), **P2 next** (MFA matters for every Cloud user, since a termhub account reaches shells on
their machines), then P3/P4 when the first company asks or when P5 is decided.

## 9. Impact on other users

This spike changes nothing: it is a document. For the phases it proposes:

- P1 adds an admin action; nobody is affected until an admin uses it. Its two gap fixes (open
  sockets closed, agents refused) also apply to self-service deletion, which is the behaviour the
  person already expects.
- P2 is **opt-in per user** (register a passkey/TOTP) with an **opt-in per instance** "require"
  setting, default off. Users who never add a factor see one new section in Settings.
- P3 and P4 are **off by default, per instance** (and per organization after P5): nothing changes
  until an admin configures a connection or a SCIM token. Google sign-in keeps working as today.
- P5 is a product change for the Cloud and gets its own Impact section.
