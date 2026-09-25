// PIN wrap/proof model (design spec §5.3-5.4). The wrap has no authentication tag on purpose:
// the app never checks the PIN locally, so an offline attacker who steals the vault cannot tell
// a wrong PIN from a right one — every guess must cost a server call.
import { hmac } from '@noble/hashes/hmac.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decisionProofMessage, type PinDecision } from '@termhub/mobile-api';
import { b64url, utf8 } from './encoding';

export const PIN_RE = /^\d{6}$/;

const PRODUCTION_LOG2N = 14;

/**
 * scrypt's cost exponent: 14 in the app, always. Only the `ui` Jest project lowers it (through
 * `TERMHUB_SCRYPT_LOG2N`, set in `test/ui-setup.js`), because every screen suite enrols and
 * unlocks for real and N = 2^14 made them time out on a slow CI runner. The mock server verifies
 * HMACs over the unwrapped secret, never the scrypt output, so the flows stay the same. The
 * `logic` project keeps the production cost, so `pin.test.ts` exercises the real parameters.
 */
export function scryptLog2N(): number {
  // `process` is guarded: nothing promises a `process.env` object in a React Native bundle.
  const raw = typeof process === 'undefined' ? undefined : process.env?.TERMHUB_SCRYPT_LOG2N;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= PRODUCTION_LOG2N ? n : PRODUCTION_LOG2N;
}

/** Derives the PIN's wrap key with scrypt (params fixed; the strength is on the server, P§5.4). */
export const deriveWrapKey = (pin: string, salt: Uint8Array): Promise<Uint8Array> =>
  scryptAsync(utf8(pin), salt, { N: 2 ** scryptLog2N(), r: 8, p: 1, dkLen: 32 });

/** XORs `secret` with `key`, byte by byte. */
export const wrapSecret = (secret: Uint8Array, key: Uint8Array): Uint8Array => secret.map((b, i) => b ^ (key[i] ?? 0));

// XOR is its own inverse; no tag on purpose (P§5.4).
export const unwrapSecret = wrapSecret;

/** base64url(HMAC-SHA256(secret, challenge)) — proves possession of the unwrapped secret. */
export const pinProof = (secret: Uint8Array, challenge: string): string => b64url(hmac(sha256, secret, utf8(challenge)));

/** The PIN key's signature over the decision it authorises — `approve` or `approve_tab` are signed as
 * different messages, so a proof for one can never be spent on the other. */
export const decisionProof = (secret: Uint8Array, challenge: string, actionId: string, decision: PinDecision): string =>
  b64url(hmac(sha256, secret, utf8(decisionProofMessage(challenge, actionId, decision))));
