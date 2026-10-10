import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { proofMessage, type HelloProof } from '@termhub/agent-protocol';
import { agentHome } from './config.js';

const KEY_FILE = 'device-key.pem';

/**
 * The machine's Ed25519 device key (TER-1017). `connect` generates it and trades the pairing token plus
 * its public half for the machine; the private half stays in `~/.termhub/device-key.pem` (0600) and only
 * ever signs the server's per-connection nonce. Pairing again replaces it.
 */
export interface DeviceKey {
  privateKey: KeyObject;
  /** Base64 SPKI DER, what `hello.pair.public_key` carries. */
  publicKey: string;
}

export function deviceKeyPath(): string {
  return path.join(agentHome(), KEY_FILE);
}

export function generateDeviceKey(): DeviceKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

/** Writes the private key atomically with the same permissions as the config (dir 0700, file 0600). */
export function writeDeviceKey(key: DeviceKey): void {
  const home = agentHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const dest = deviceKeyPath();
  const tmp = path.join(home, `.${KEY_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);
}

/** Reads the device key; null when the file is missing or is not an Ed25519 private key. */
export function readDeviceKey(): DeviceKey | null {
  let pem: string;
  try {
    pem = fs.readFileSync(deviceKeyPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

/** Removes the device key, if any. Never throws when it is already gone. */
export function deleteDeviceKey(): void {
  try {
    fs.unlinkSync(deviceKeyPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** The `hello.proof` answering the server's `challenge`. */
export function signChallenge(key: DeviceKey, nonce: string, machineId: string, ts = Date.now()): HelloProof {
  return { machine_id: machineId, ts, sig: sign(null, proofMessage(nonce, machineId, ts), key.privateKey).toString('base64') };
}
