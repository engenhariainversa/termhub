import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROOF_SKEW_MS, proofMessage } from '@termhub/agent-protocol';
import { AGENT_TOKEN_RE, checkDeviceProof, hashAgentToken, newAgentToken, newChallengeNonce, normalizeDevicePublicKey } from './token.js';

describe('agent token', () => {
  it('generates thb_ag_ + 43 base64url chars and a sha256 hash', () => {
    const { token, hash } = newAgentToken();
    expect(token).toMatch(AGENT_TOKEN_RE);
    expect(token.length).toBe('thb_ag_'.length + 43);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentToken(token)).toBe(hash);
  });
  it('never repeats', () => expect(newAgentToken().token).not.toBe(newAgentToken().token));
});

describe('device key (TER-1017)', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const now = 1_800_000_000_000;
  const signed = (nonce: string, machineId: string, ts: number) => sign(null, proofMessage(nonce, machineId, ts), keys.privateKey).toString('base64');

  it('normalizes an Ed25519 SPKI key and refuses anything else', () => {
    expect(normalizeDevicePublicKey(publicKey)).toBe(publicKey);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(normalizeDevicePublicKey(rsa)).toBeNull();
    expect(normalizeDevicePublicKey('not a key')).toBeNull();
  });

  it('accepts a proof over this nonce, machine and a fresh timestamp', () => {
    const proof = { machine_id: 'm1', ts: now, sig: signed('n0nce', 'm1', now) };
    expect(checkDeviceProof({ publicKey, machineId: 'm1', nonce: 'n0nce', proof, now })).toEqual({ ok: true });
  });

  it('refuses a missing proof, another machine, a stale timestamp or a bad signature', () => {
    const base = { publicKey, machineId: 'm1', nonce: 'n0nce', now };
    expect(checkDeviceProof({ ...base, proof: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(checkDeviceProof({ ...base, proof: { machine_id: 'm2', ts: now, sig: signed('n0nce', 'm2', now) } })).toEqual({ ok: false, reason: 'machine' });
    const old = now - PROOF_SKEW_MS - 1;
    expect(checkDeviceProof({ ...base, proof: { machine_id: 'm1', ts: old, sig: signed('n0nce', 'm1', old) } })).toEqual({ ok: false, reason: 'stale' });
    expect(checkDeviceProof({ ...base, proof: { machine_id: 'm1', ts: now, sig: signed('other', 'm1', now) } })).toEqual({ ok: false, reason: 'signature' });
    expect(checkDeviceProof({ ...base, proof: { machine_id: 'm1', ts: now, sig: '!!' } })).toEqual({ ok: false, reason: 'signature' });
  });

  it('challenge nonces are fresh', () => expect(newChallengeNonce()).not.toBe(newChallengeNonce()));
});
