import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { PROOF_SKEW_MS, proofMessage, type HelloProof } from '@termhub/agent-protocol';

export const AGENT_TOKEN_RE = /^thb_ag_[A-Za-z0-9_-]{43}$/;
export const hashAgentToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** 256-bit random token; only the hash is stored. Since TER-1017 the app only mints pairing tokens with it. */
export function newAgentToken(): { token: string; hash: string } {
  const token = `thb_ag_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashAgentToken(token) };
}

/** The nonce a device-key dial signs; fresh per connection, so a proof can never be replayed elsewhere. */
export const newChallengeNonce = (): string => randomBytes(32).toString('base64url');

/**
 * The SPKI DER (base64) of an Ed25519 public key, re-encoded from what the agent sent; null for anything
 * else (another key type, garbage). Storing the re-encoding keeps one canonical form per key.
 */
export function normalizeDevicePublicKey(b64: string): string | null {
  try {
    const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return key.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch {
    return null;
  }
}

export type ProofFailure = 'missing' | 'machine' | 'stale' | 'signature';

/** Checks a hello's `proof` against the machine's stored key and the nonce this connection sent. */
export function checkDeviceProof(
  input: { publicKey: string; machineId: string; nonce: string; proof: HelloProof | undefined; now?: number },
): { ok: true } | { ok: false; reason: ProofFailure } {
  const { proof } = input;
  if (!proof) return { ok: false, reason: 'missing' };
  if (proof.machine_id !== input.machineId) return { ok: false, reason: 'machine' };
  if (Math.abs((input.now ?? Date.now()) - proof.ts) > PROOF_SKEW_MS) return { ok: false, reason: 'stale' };
  try {
    const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), format: 'der', type: 'spki' });
    const good = verify(null, proofMessage(input.nonce, input.machineId, proof.ts), key, Buffer.from(proof.sig, 'base64'));
    return good ? { ok: true } : { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
}
