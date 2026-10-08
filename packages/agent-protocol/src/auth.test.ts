import { describe, expect, it } from 'vitest';
import { handshakeMessage, proofMessage } from './auth.js';
import { helloMessage, serverMessage } from './messages.js';

const hello = { type: 'hello', protocol: 1, agent_version: '0.25.0', os: 'linux', arch: 'x64', hostname: 'box', tmux: true, tools: [] };

describe('agent auth messages (TER-1017)', () => {
  it('a hello from before TER-1017 still parses, with neither pair nor proof', () => {
    const parsed = helloMessage.parse(hello);
    expect(parsed.pair).toBeUndefined();
    expect(parsed.proof).toBeUndefined();
  });

  it('a hello carries a pairing key or a proof', () => {
    expect(helloMessage.parse({ ...hello, pair: { public_key: 'A'.repeat(60) } }).pair).toEqual({ public_key: 'A'.repeat(60) });
    expect(helloMessage.parse({ ...hello, proof: { machine_id: 'm1', ts: 1, sig: 'c2ln' } }).proof).toEqual({ machine_id: 'm1', ts: 1, sig: 'c2ln' });
    expect(helloMessage.safeParse({ ...hello, pair: { public_key: 'short' } }).success).toBe(false);
  });

  it('handshake messages stay out of the session messages', () => {
    const challenge = { type: 'challenge', nonce: 'n'.repeat(43) };
    expect(handshakeMessage.parse(challenge)).toEqual(challenge);
    expect(serverMessage.safeParse(challenge).success).toBe(false);
    expect(handshakeMessage.parse({ type: 'paired', machine_id: 'm1', machine_name: 'mini' }).type).toBe('paired');
  });

  it('the signed message keeps each field on its own line', () => {
    expect(proofMessage('abc', 'm1', 42).toString('utf8')).toBe('termhub-agent-proof/v1\nabc\nm1\n42');
  });
});
