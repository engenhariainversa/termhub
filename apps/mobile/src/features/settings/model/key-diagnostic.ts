// The device-key diagnostic (P§11.1's first on-device check, design spec §10): runs every
// `DeviceKey` operation against a *dedicated* key the caller injects — `Ajustes` builds it on the
// `dev.termhub.diagnostic` hardware tag (Jest: vault key `key.diagnostic`), never the enrolled key — so the
// diagnostic can never disturb the real session (ruling: "the diagnostic never touches the
// enrolled key").
import { p256 } from '@noble/curves/nist.js';
import { t } from '@/i18n';
import { utf8 } from '@/services/crypto/encoding';
import { jwkThumbprint, jwkToUncompressed } from '@/services/key/jwk';
import type { DeviceKey, P256Jwk } from '@/services/key/types';

export interface KeyDiagnosticStep {
  name: string;
  ok: boolean;
  /** The error's own message on failure; absent on success. Never the key material. */
  detail?: string;
}

export interface KeyDiagnosticResult {
  ok: boolean;
  steps: KeyDiagnosticStep[];
}

const MESSAGE = utf8('termhub-key-diagnostic');

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `create` / `exists` / `publicJwk` / `thumbprint` / `sign+verify` / `destroy`, in order (P§11.1). Every step
 * runs even after an earlier one failed, so a broken `sign()` still gets to `destroy()` — the
 * diagnostic never leaves a half-made key behind. A step's own thrown error becomes `ok: false`
 * with its `message` as `detail`; nothing about the key itself is ever put in a detail string.
 */
export async function runKeyDiagnostic(key: DeviceKey): Promise<KeyDiagnosticResult> {
  const steps: KeyDiagnosticStep[] = [];
  let created: P256Jwk | null = null;

  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      steps.push({ name, ok: true });
    } catch (e) {
      steps.push({ name, ok: false, detail: messageOf(e) });
    }
  };

  await step('create', async () => {
    created = await key.create();
    if (created.kty !== 'EC' || created.crv !== 'P-256') throw new Error(t('A chave criada não é P-256.'));
  });

  await step('exists', async () => {
    if (!(await key.exists())) throw new Error(t('A chave não existe depois de criada.'));
  });

  await step('publicJwk', async () => {
    const pub = await key.publicJwk();
    if (!created || pub.x !== created.x || pub.y !== created.y) throw new Error(t('A chave pública não confere com a criada.'));
  });

  await step('thumbprint', async () => {
    // RFC 7638 over the key the platform hands back: 32 bytes of SHA-256, 43 base64url chars.
    if (!/^[A-Za-z0-9_-]{43}$/.test(jwkThumbprint(await key.publicJwk()))) throw new Error(t('A impressão digital da chave não tem 43 caracteres.'));
  });

  await step('sign+verify', async () => {
    const sig = await key.sign(MESSAGE);
    if (sig.length !== 64) throw new Error(t('A assinatura não tem 64 bytes.'));
    if (!created) throw new Error(t('Sem chave pública para verificar a assinatura.'));
    if (!p256.verify(sig, MESSAGE, jwkToUncompressed(created), { prehash: true })) {
      throw new Error(t('A assinatura não passou na verificação.'));
    }
  });

  await step('destroy', async () => {
    await key.destroy();
    if (await key.exists()) throw new Error(t('A chave ainda existe depois de destruída.'));
  });

  return { ok: steps.every((s) => s.ok), steps };
}
