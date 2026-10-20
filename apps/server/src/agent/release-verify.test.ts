import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PROVENANCE_POLICY, verifyAgentRelease } from './release-verify.js';

const VERSION = '0.20.0';
const digest = createHash('sha512').update('the tarball').digest();
const INTEGRITY = `sha512-${digest.toString('base64')}`;
const ATTESTATIONS_URL = 'https://registry.npmjs.org/-/npm/v1/attestations/@termhub%2fagent@0.20.0';

function statement(subject: { name: string; digest: Record<string, string> }[]) {
  return Buffer.from(JSON.stringify({ _type: 'https://in-toto.io/Statement/v1', subject, predicateType: 'https://slsa.dev/provenance/v1' })).toString('base64');
}

function registry(opts: { integrity?: string; attestationsUrl?: string | null; attestations?: unknown[]; subject?: { name: string; digest: Record<string, string> }[] } = {}) {
  const subject = opts.subject ?? [{ name: `pkg:npm/%40termhub/agent@${VERSION}`, digest: { sha512: digest.toString('hex') } }];
  const bundle = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', dsseEnvelope: { payload: statement(subject), payloadType: 'application/vnd.in-toto+json', signatures: [] } };
  const attestations = opts.attestations ?? [
    { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { dsseEnvelope: { payload: '' } } },
    { predicateType: 'https://slsa.dev/provenance/v1', bundle },
  ];
  const attestationsUrl = opts.attestationsUrl === undefined ? ATTESTATIONS_URL : opts.attestationsUrl;
  const fetchJson = vi.fn(async (url: string) => {
    if (url === `https://registry.npmjs.org/@termhub/agent/${VERSION}`) {
      const dist: Record<string, unknown> = { integrity: opts.integrity ?? INTEGRITY };
      if (attestationsUrl) dist.attestations = { url: attestationsUrl, provenance: { predicateType: 'https://slsa.dev/provenance/v1' } };
      return { status: 200, body: { name: '@termhub/agent', version: VERSION, dist }, text: '', headers: new Headers() };
    }
    if (url === attestationsUrl) return { status: 200, body: { attestations }, text: '', headers: new Headers() };
    return { status: 404, body: null, text: '', headers: new Headers() };
  });
  return { fetchJson, bundle };
}

describe('verifyAgentRelease', () => {
  it('approves a release whose provenance verifies and signs the registry integrity', async () => {
    const { fetchJson, bundle } = registry();
    const verifyBundle = vi.fn(async () => ({}));
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle })).resolves.toEqual({ version: VERSION, integrity: INTEGRITY });
    expect(verifyBundle).toHaveBeenCalledWith(bundle, expect.objectContaining({ ...PROVENANCE_POLICY, tufCachePath: expect.stringContaining('termhub-sigstore-tuf') }));
  });

  it('pins the signer to this repo\'s publish workflow, from main or an agent tag', () => {
    const re = new RegExp(PROVENANCE_POLICY.certificateIdentityURI);
    expect(re.test('https://github.com/engenhariainversa/termhub/.github/workflows/publish-agent.yml@refs/heads/main')).toBe(true);
    expect(re.test('https://github.com/engenhariainversa/termhub/.github/workflows/publish-agent.yml@refs/tags/agent-v0.20.0')).toBe(true);
    expect(re.test('https://github.com/someone/termhub/.github/workflows/publish-agent.yml@refs/heads/main')).toBe(false);
    expect(re.test('https://github.com/engenhariainversa/termhub/.github/workflows/other.yml@refs/heads/main')).toBe(false);
    expect(re.test('https://github.com/engenhariainversa/termhub/.github/workflows/publish-agent.yml@refs/heads/feature')).toBe(false);
  });

  it('refuses a release published without provenance', async () => {
    const verifyBundle = vi.fn(async () => ({}));
    await expect(verifyAgentRelease(VERSION, { fetchJson: registry({ attestationsUrl: null }).fetchJson, verifyBundle })).rejects.toThrow(/without provenance/);
    await expect(verifyAgentRelease(VERSION, { fetchJson: registry({ attestationsUrl: 'https://evil.example/attestations' }).fetchJson, verifyBundle })).rejects.toThrow(/without provenance/);
    const onlyPublish = registry({ attestations: [{ predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: {} }] });
    await expect(verifyAgentRelease(VERSION, { fetchJson: onlyPublish.fetchJson, verifyBundle })).rejects.toThrow(/no SLSA provenance/);
    expect(verifyBundle).not.toHaveBeenCalled();
  });

  it('refuses when the signed digest differs from the registry integrity', async () => {
    const other = createHash('sha512').update('another tarball').digest('hex');
    const { fetchJson } = registry({ subject: [{ name: `pkg:npm/%40termhub/agent@${VERSION}`, digest: { sha512: other } }] });
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle: async () => ({}) })).rejects.toThrow(/does not match/);
  });

  it('refuses a provenance for another package or version', async () => {
    const { fetchJson } = registry({ subject: [{ name: 'pkg:npm/%40termhub/agent@0.19.0', digest: { sha512: digest.toString('hex') } }] });
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle: async () => ({}) })).rejects.toThrow(/does not name/);
  });

  it('refuses when sigstore rejects the bundle (bad signature, wrong signer)', async () => {
    const { fetchJson } = registry();
    const verifyBundle = vi.fn(async () => {
      throw new Error('certificate identity error');
    });
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle })).rejects.toThrow(/sigstore verification failed: certificate identity error/);
  });

  it('refuses an integrity that is not sha512', async () => {
    const { fetchJson } = registry({ integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=' });
    const verifyBundle = vi.fn(async () => ({}));
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle })).rejects.toThrow(/not sha512/);
    expect(verifyBundle).not.toHaveBeenCalled();
  });

  it('refuses when the registry does not answer', async () => {
    const fetchJson = vi.fn(async () => ({ status: 503, body: null, text: '', headers: new Headers() }));
    await expect(verifyAgentRelease(VERSION, { fetchJson, verifyBundle: async () => ({}) })).rejects.toThrow(/HTTP 503/);
  });
});
