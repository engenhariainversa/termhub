import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from './encoding';
import { decisionProof, deriveWrapKey, pinProof, scryptLog2N, unwrapSecret, wrapSecret } from './pin';

const secret = new Uint8Array(32).map((_, i) => (i * 7) % 256);
const salt = new Uint8Array(16).fill(3);

describe('pin model', () => {
  it('wraps and unwraps with the right PIN', async () => {
    const k = await deriveWrapKey('123456', salt);
    expect(unwrapSecret(wrapSecret(secret, k), k)).toEqual(secret);
  });
  it('any PIN unwraps to 32 plausible bytes — nothing tells a wrong one apart offline', async () => {
    const wrapped = wrapSecret(secret, await deriveWrapKey('123456', salt));
    const wrong = unwrapSecret(wrapped, await deriveWrapKey('654321', salt));
    expect(wrong).toHaveLength(32);
    expect(wrong).not.toEqual(secret);
  });
  it('pin_proof is base64url(HMAC-SHA256(secret, challenge))', () => {
    expect(pinProof(secret, 'chal')).toBe(b64url(hmac(sha256, secret, utf8('chal'))));
  });
  it('decision proof signs challenge, action id and the decision word, newline-separated', () => {
    expect(decisionProof(secret, 'c1', 'a1', 'approve')).toBe(b64url(hmac(sha256, secret, utf8('c1\na1\napprove'))));
    expect(decisionProof(secret, 'c1', 'a1', 'approve_tab')).toBe(b64url(hmac(sha256, secret, utf8('c1\na1\napprove_tab'))));
  });

  it('derives with the production cost (N = 2^14) unless the ui Jest project lowers it', () => {
    const saved = process.env.TERMHUB_SCRYPT_LOG2N;
    try {
      delete process.env.TERMHUB_SCRYPT_LOG2N;
      expect(scryptLog2N()).toBe(14);
      process.env.TERMHUB_SCRYPT_LOG2N = '10';
      expect(scryptLog2N()).toBe(10);
      process.env.TERMHUB_SCRYPT_LOG2N = 'nope';
      expect(scryptLog2N()).toBe(14);
    } finally {
      if (saved === undefined) delete process.env.TERMHUB_SCRYPT_LOG2N;
      else process.env.TERMHUB_SCRYPT_LOG2N = saved;
    }
  });
});
