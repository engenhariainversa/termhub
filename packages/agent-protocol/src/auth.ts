import { z } from 'zod';

/**
 * How an agent proves who it is (TER-1017). Two credentials coexist:
 *
 * - **bearer** (agents before 0.22.0, and machines nobody paired again): `Authorization: Bearer thb_ag_…`
 *   on every dial, the token the app showed. Permanent until rotated.
 * - **device key**: the app shows a *pairing* token instead, single use, valid for 15 minutes. `connect`
 *   dials with it as a bearer and a `hello.pair` carrying a fresh Ed25519 public key; the server burns
 *   the token, stores the key and answers `paired` with the machine. From then on the agent dials with
 *   `Authorization: TermhubDevice <machine id>`, the server sends a `challenge`, and the hello carries
 *   `proof`: the signature of `proofMessage(nonce, machine id, ts)` with the private key, which never
 *   leaves the machine.
 *
 * Pairing rides the same `/agent/ws` dial on purpose: it is the one path a Cloudflare Access bypass
 * already lets through in front of the app.
 */
export const DEVICE_AUTH_SCHEME = 'TermhubDevice';

/** How long a pairing token stays valid after the app shows it. */
export const PAIRING_TTL_MS = 15 * 60_000;

/** How far the proof's timestamp may drift from the server clock. The nonce is per connection, so
 *  this only bounds a proof captured and replayed on the same socket, which cannot happen; it is here
 *  so a badly skewed clock shows up as a clear refusal instead of passing unnoticed. */
export const PROOF_SKEW_MS = 5 * 60_000;

/** The bytes the agent signs. Versioned and newline-separated so no field can be shifted into another. */
export function proofMessage(nonce: string, machineId: string, ts: number): Buffer {
  return Buffer.from(`termhub-agent-proof/v1\n${nonce}\n${machineId}\n${ts}`, 'utf8');
}

/** Base64 of the SPKI DER of an Ed25519 public key: 44 bytes, 60 characters. */
export const devicePublicKey = z.string().min(40).max(200);

export const helloPair = z.object({ public_key: devicePublicKey });
export const helloProof = z.object({
  machine_id: z.string().min(1).max(64),
  ts: z.number().int(),
  sig: z.string().min(1).max(200),
});

/** Server → agent, before the agent's hello: the nonce a device-key dial signs. */
export const challengeMessage = z.object({ type: z.literal('challenge'), nonce: z.string().min(16).max(128) });
/** Server → agent, answering a pairing hello: the token is burnt and the key stored. The server then closes 1000 `paired`. */
export const pairedMessage = z.object({ type: z.literal('paired'), machine_id: z.string().min(1).max(64), machine_name: z.string().max(200) });
/** The messages of the handshake, kept out of `serverMessage`: they only travel before a session attaches. */
export const handshakeMessage = z.discriminatedUnion('type', [challengeMessage, pairedMessage]);

export type HandshakeMessage = z.infer<typeof handshakeMessage>;
export type HelloProof = z.infer<typeof helloProof>;
