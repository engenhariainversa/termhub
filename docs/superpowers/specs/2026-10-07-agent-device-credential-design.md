# Agent: single-use pairing token + device key (TER-1017)

Origin: TER-584, §1 of `2026-10-07-agent-release-trust-and-uninstall-design.md` (the evaluation that
proposed this). Agent 0.25.0.

## Before

`thb_ag_…` was both the pairing token the app shows and the machine's permanent credential: `connect`
saved it in `~/.termhub/config.json` and sent it as a bearer on every dial. It never expired.

## After

- **Pairing token.** The app (new machine, or "Parear de novo") mints a `thb_ag_…` token that works
  **once** and for **15 minutes** (`PAIRING_TTL_MS`). The server keeps its SHA-256 in
  `machines.agent_pairing_hash` / `agent_pairing_expires_at`.
- **Pairing.** `termhub-agent connect` generates an Ed25519 key pair, dials `/agent/ws` with the token as
  a bearer and a hello carrying `pair.public_key` (SPKI DER, base64) and `probe: true`. The server burns
  the token and stores the key in one conditional `UPDATE` (two racing dials: one wins), answers
  `{type: 'paired', machine_id, machine_name}` and closes `1000 paired`. The agent writes
  `~/.termhub/device-key.pem` (`0600`) and a config with `credential: 'key'` and the machine id — no token.
- **Every later dial.** `Authorization: TermhubDevice <machine id>`. The server sends
  `{type: 'challenge', nonce}` (32 random bytes, per connection); the hello carries
  `proof: {machine_id, ts, sig}`, the Ed25519 signature of
  `termhub-agent-proof/v1\n<nonce>\n<machine id>\n<ts>`. A wrong key, nonce, machine or a timestamp more
  than 5 minutes off closes `4401 proof`; a machine with no key is refused at the upgrade (401).
- **"Parear de novo"** (the old "Rotacionar token", same route `POST /api/machines/:id/agent-token`):
  mints a new pairing token and revokes both the device key and the legacy bearer, then closes the live
  connection with 4401 as before.
- **4409** (the newest connection wins) is unchanged.

### Departure from the TER-584 proposal

The proposal named an HTTP `POST /agent/pair`. Pairing rides the `/agent/ws` dial instead: in termhub
Cloud the app sits behind Cloudflare Access, and the only path with a bypass for agents is `/agent/ws`.
A new HTTP path would have needed a new Access application and an nginx rule on every self-hosted
install that fronts the app the same way. The exchange is the same: token + public key in, machine out,
token burnt.

## Compatibility

- **Existing machines** keep `agent_token_hash` and their agents keep dialing with it (`credential`
  `bearer`). Nothing breaks on deploy; the machine row exposes `agent_credential` (`key` / `bearer` /
  null, derived from which columns are set) and the agent tab asks to update and pair again.
- **An old agent given a pairing token** (it sends no `pair`) is closed `4409 protocol`, which it already
  prints as "Atualize o agente". The token stays unused.
- **A new agent against an older server**: the older server ignores `pair` and answers the probe with
  `probe-ok`; `connect` then saves the token as a bearer config, exactly as before.
- **Configs** written before 0.25.0 have no `credential` field and read as `bearer`.
- **Migration** only adds nullable columns and a unique index; the previous release never reads them.
  During the blue/green window, a pairing token minted by the new color is unknown to the old one.

## Impact on other users

Default for everyone, no setting: new machines and "Parear de novo" now give a single-use token valid
15 minutes, and the machine keeps a device key instead of a permanent token. Machines already paired keep
working unchanged until someone pairs them again; the app shows them a note asking to update the agent
and pair again. Anyone who pastes a pairing token into an agent older than 0.25.0 is told to update it.
