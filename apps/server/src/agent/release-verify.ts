import os from 'node:os';
import path from 'node:path';
import { SHA512_INTEGRITY_RE } from '@termhub/agent-protocol';
import type { Bundle, VerifyOptions } from 'sigstore';
import { httpJson } from '../lib/http-json.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Provenance check of an @termhub/agent release before the server offers it (spec 2026-10-07 agent
 * release trust §2). A version is adopted only when:
 *  - the registry's `dist.integrity` for it is a `sha512-…`;
 *  - its SLSA provenance attestation verifies with Sigstore (Fulcio chain, transparency log) and was
 *    signed by this repo's `publish-agent.yml` workflow, from `main` or an `agent-vX.Y.Z` tag;
 *  - the signed statement's subject is `pkg:npm/%40termhub/agent@<version>` with that same SHA-512.
 * It covers the agent tarball, not its dependencies (npm resolves those by range at install time).
 * Sigstore's trust root comes from its TUF mirror (`tuf-repo-cdn.sigstore.dev`), cached under the OS temp dir.
 */
const PACKAGE = '@termhub/agent';
const REGISTRY = 'https://registry.npmjs.org';
const ATTESTATIONS_PREFIX = `${REGISTRY}/-/npm/v1/attestations/`;
const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const SEMVER = /^\d+\.\d+\.\d+$/;

export const PROVENANCE_POLICY = {
  certificateIssuer: 'https://token.actions.githubusercontent.com',
  certificateIdentityURI: '^https://github\\.com/engenhariainversa/termhub/\\.github/workflows/publish-agent\\.yml@refs/(heads/main|tags/agent-v\\d+\\.\\d+\\.\\d+)$',
} as const;

export interface VerifiedRelease {
  version: string;
  /** `sha512-…` of the tarball, as the registry reports it and the provenance signs it. */
  integrity: string;
}

export interface ReleaseVerifyDeps {
  fetchJson?: typeof httpJson;
  /** sigstore's `verify(bundle, options)`; throws when the bundle or the signer does not check out. */
  verifyBundle?: (bundle: Bundle, options: VerifyOptions) => Promise<unknown>;
}

async function defaultVerifyBundle(bundle: Bundle, options: VerifyOptions): Promise<unknown> {
  // Loaded on first use: most boots never verify anything until a new release shows up.
  const { verify } = await import('sigstore');
  return verify(bundle, options);
}

async function getJson(fetchJson: typeof httpJson, url: string, what: string): Promise<Record<string, unknown>> {
  const r = await fetchJson(url, { headers: { accept: 'application/json' }, timeoutMs: 10_000 });
  if (r.status !== 200 || !isObj(r.body)) throw new Error(`${what}: HTTP ${r.status} from the npm registry`);
  return r.body;
}

/** Verifies `version` of @termhub/agent against its provenance; resolves with the approved integrity or throws why not. */
export async function verifyAgentRelease(version: string, deps: ReleaseVerifyDeps = {}): Promise<VerifiedRelease> {
  const fetchJson = deps.fetchJson ?? httpJson;
  const verifyBundle = deps.verifyBundle ?? defaultVerifyBundle;
  if (!SEMVER.test(version)) throw new Error(`not a plain x.y.z version: ${version}`);

  const manifest = await getJson(fetchJson, `${REGISTRY}/${PACKAGE}/${version}`, 'package manifest');
  const dist = isObj(manifest.dist) ? manifest.dist : {};
  const integrity = dist.integrity;
  if (typeof integrity !== 'string' || !SHA512_INTEGRITY_RE.test(integrity)) throw new Error('dist.integrity is missing or not sha512');
  const attestationsUrl = isObj(dist.attestations) ? dist.attestations.url : undefined;
  if (typeof attestationsUrl !== 'string' || !attestationsUrl.startsWith(ATTESTATIONS_PREFIX)) {
    throw new Error('the release has no npm attestations (published without provenance)');
  }

  const body = await getJson(fetchJson, attestationsUrl, 'attestations');
  const list = Array.isArray(body.attestations) ? body.attestations : [];
  const provenance = list.find((a): a is Record<string, unknown> => isObj(a) && a.predicateType === SLSA_PROVENANCE_V1);
  if (!provenance || !isObj(provenance.bundle)) throw new Error('no SLSA provenance attestation for the release');
  const bundle = provenance.bundle as unknown as Bundle;

  try {
    await verifyBundle(bundle, { ...PROVENANCE_POLICY, tufCachePath: path.join(os.tmpdir(), 'termhub-sigstore-tuf') });
  } catch (err) {
    throw new Error(`sigstore verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The signature covers the DSSE envelope; what it says is in the in-toto statement it carries.
  const payload = (bundle as { dsseEnvelope?: { payload?: unknown } }).dsseEnvelope?.payload;
  if (typeof payload !== 'string') throw new Error('the provenance bundle carries no DSSE payload');
  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('the provenance statement is not JSON');
  }
  const subjects = isObj(statement) && Array.isArray(statement.subject) ? statement.subject : [];
  const name = `pkg:npm/%40termhub/agent@${version}`;
  const subject = subjects.find((s): s is Record<string, unknown> => isObj(s) && s.name === name);
  if (!subject) throw new Error(`the provenance does not name ${name}`);
  const signedHex = isObj(subject.digest) && typeof subject.digest.sha512 === 'string' ? subject.digest.sha512.toLowerCase() : null;
  const registryHex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  if (signedHex !== registryHex) throw new Error('the signed sha512 does not match the registry integrity');

  return { version, integrity };
}
