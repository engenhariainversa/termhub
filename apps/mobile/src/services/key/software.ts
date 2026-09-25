// Software device key: P-256 (@noble/curves), private key in SecureStore (design spec §2
// "Device key"). Backs the mock, every Jest run and development builds on a simulator; never
// used against the real server by a production build (see index.ts).
import { p256 } from '@noble/curves/nist.js';
import { b64url, fromB64url } from '../crypto/encoding';
import { vault, type VaultKey } from '../vault';
import { jwkFromUncompressed } from './jwk';
import type { DeviceKey, P256Jwk } from './types';

export class SoftwareDeviceKey implements DeviceKey {
  constructor(private readonly vaultKey: VaultKey = 'key.private') {}

  private async secret(): Promise<Uint8Array> {
    const s = await vault.get(this.vaultKey);
    if (!s) throw new Error('KEY_MISSING');
    return fromB64url(s);
  }

  async create(): Promise<P256Jwk> {
    const sk = p256.utils.randomSecretKey();
    await vault.set(this.vaultKey, b64url(sk));
    return jwkFromUncompressed(p256.getPublicKey(sk, false));
  }

  async exists(): Promise<boolean> {
    return (await vault.get(this.vaultKey)) !== null;
  }

  async publicJwk(): Promise<P256Jwk> {
    return jwkFromUncompressed(p256.getPublicKey(await this.secret(), false));
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return p256.sign(message, await this.secret(), { prehash: true, format: 'compact' });
  }

  async destroy(): Promise<void> {
    await vault.delete(this.vaultKey);
  }
}
