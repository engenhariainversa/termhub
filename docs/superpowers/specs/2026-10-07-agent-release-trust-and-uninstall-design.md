# Agent: verified self-update, "uninstall from the machine", and the credential review (TER-584)

Origin: TER-543 (security review). The card lists four gaps in how the termhub agent is trusted and
removed. Two are built here (§2, §3); two were evaluation items, answered in §1 and §4.

## 1. The `thb_ag_` token as a permanent credential (evaluation)

Today `termhub-agent connect --token thb_ag_…` stores the enrollment token in `~/.termhub/config.json`
(`0600`) and sends it as a bearer on every WebSocket dial. The server keeps its SHA-256. It never
expires; rotating it in the app (or deleting the machine) closes the connection with 4401, and a second
connection with the same token replaces the first (4409).

**Proposal, tracked as TER-1017 (not built here):** split the two roles the token plays today.

- **Pairing token**: what the app shows. Single use, valid for 15 minutes, still `thb_ag_…` so the
  copy-paste flow does not change.
- **Device credential**: on `connect`, the agent generates an Ed25519 key pair (private key `0600` in
  `~/.termhub/`, never sent), and trades the pairing token plus its public key for the machine
  (`POST /agent/pair`). The pairing token is burnt. Every dial then proves possession: the server sends a
  nonce in the handshake and the agent signs `nonce ‖ machine id ‖ timestamp`, like the mobile app's
  DPoP proof (`apps/server/src/mobile/`). A stolen `config.json` stays a risk (the key sits next to it),
  but a token leaked from a terminal, a screenshot or a shell history no longer gives a permanent seat.
- Rotation in the app becomes "pair again": it revokes the stored public key and mints a new pairing
  token.
- Compatibility: agents that only know bearer tokens keep working until the person pairs again; the
  machine row records which kind it uses, and the app nudges old ones to update.

Why not now: it touches the enrollment UI, the agent's config format, the WebSocket handshake and a
migration, and every existing machine has to migrate without losing its tmux sessions. It is a
release of its own. The 4409 behaviour (the newest connection wins) stays as it is: it is what lets an
agent restarted by its service take its seat back without waiting for the old socket to time out.

## 2. Self-update installs only a release the server verified

Before: the server polled `registry.npmjs.org/@termhub/agent/latest` and told agents to
`npm install -g @termhub/agent@<that version>`. The package is published with provenance
(`publish-agent.yml`, npm trusted publishing), but nothing checked it.

After:

1. When the registry reports a new latest version, the server **verifies** it before adopting it:
   - reads `registry.npmjs.org/@termhub/agent/<version>`: `dist.integrity` must be a `sha512-…`;
   - reads the attestations (`/-/npm/v1/attestations/@termhub%2fagent@<version>`), takes the SLSA
     provenance (`https://slsa.dev/provenance/v1`) bundle and verifies it with `sigstore`: Fulcio
     certificate chain, transparency log, and the signer identity — issuer
     `https://token.actions.githubusercontent.com`, SAN
     `https://github.com/engenhariainversa/termhub/.github/workflows/publish-agent.yml@refs/heads/main`
     (or `@refs/tags/agent-vX.Y.Z`, the tag trigger of the same workflow);
   - the signed statement's subject must be `pkg:npm/%40termhub/agent@<version>` with a `sha512` digest
     equal to `dist.integrity`.
2. Only a verified version becomes the "latest" the app shows and the auto-update installs. A version
   that fails is logged (`warn`) and skipped: the previous verified version stays, so the app never
   offers an update the server could not vouch for. Verification is retried on the next hourly poll.
3. `agent.update` carries the approved `integrity`. An agent that knows it (0.22.0+) downloads the
   tarball with `npm pack @termhub/agent@<version>` into a private temp dir, checks its SHA-512
   against `integrity`, and installs **that file** (`npm install -g <file>.tgz`). A mismatch fails the
   update without installing anything. Older agents ignore the field and install by version, which npm
   checks against the same registry integrity.

Limits, written down in `docs/security-and-network.md`: the check covers the `@termhub/agent` tarball,
not its dependencies (`ws`, `zod`, `node-pty`), which npm resolves by semver range at install time.
Verification needs the server to reach Sigstore's TUF mirror (`tuf-repo-cdn.sigstore.dev`) besides the
npm registry; the trust root is cached under the OS temp dir.

## 3. "Uninstall from the machine" when deleting it

Before: deleting a machine dropped the agent's connection (4401) and the row; the launchd/systemd
service, the hooks and the tabs' tmux sessions stayed on the machine, and the service kept retrying
until it saw the 4401.

After, the delete dialog of an **online agent machine on agent 0.22.0+** has a checkbox (on by
default) "Também desinstalar da máquina". With it, `DELETE /api/machines/:id?uninstall=1`:

1. removes the monitor hooks (`hooks.uninstall`, with the Claude account dirs, as "remover hooks" does);
2. kills the tmux sessions of the machine's tabs (best effort, as unlinking a project does);
3. calls the new `agent.uninstall` RPC: the agent removes its service definition (plist / systemd
   unit, disabled first), deletes its config (`config.json`, the token), replies, and then stops: the
   service stop, or `exit(0)` when it runs in the foreground — 0, so neither launchd nor systemd
   relaunches it;
4. deletes the machine exactly like a plain delete.

A failure in step 1 or 3 aborts before step 4 with the error, so the person can retry or untick the
box. The npm package itself stays installed (`npm rm -g @termhub/agent` removes it; the dialog says so).

When the machine is offline or its agent is older, the dialog shows the manual steps instead:
`termhub-agent service uninstall`, `termhub-agent disconnect`, `npm rm -g @termhub/agent`. The same steps
go into the agent README and the security doc.

## 4. The hourly registry poll (evaluation)

The server asks the npm registry for the latest agent version once an hour. It sends nothing about
machines or users (an anonymous `GET`), and it feeds two things: the auto-update **and** the
"atualização disponível" badge on every agent machine, which works for machines without auto-update.
So it cannot simply stop when no machine has auto-update on. What changes: the poll is skipped while
**no agent is connected**, since then neither the badge nor the auto-update has anyone to serve. With
§2 each new version also costs one attestation fetch and one Sigstore check, once.

## Impact on other users

- Auto-update and the update button: same behaviour for everyone, but a release whose provenance does
  not verify is no longer offered. Nothing to configure.
- Deleting a machine: the uninstall checkbox is on by default for online agents on 0.22.0+; unticking
  it keeps today's behaviour. Offline/older machines get the manual steps. Default, per action.
- Servers with no agent connected stop polling npm until one connects.
- The credential change (§1) is a proposal only; nothing changes for anyone yet.
