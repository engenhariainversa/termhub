import { expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { API_TOKEN_RE } from '../auth/api-tokens.js';
import { CONCIERGE_TOKEN_NAME, mintConciergeToken } from './token.js';

function repos() {
  const apiTokens = {
    revokeLiveConcierge: vi.fn(async () => 1),
    create: vi.fn(async (userId: string, input: unknown, hash: string) => ({ id: 'tok_new', userId, input, hash })),
  };
  return { apiTokens } as unknown as Repositories & { apiTokens: typeof apiTokens };
}

it('creates a token that looks like an API token and never returns the hash', async () => {
  const r = repos();
  const token = await mintConciergeToken(r, 'u1', 'c1', ['read']);
  expect(token).toMatch(API_TOKEN_RE);
  const [, input, hash] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ name: CONCIERGE_TOKEN_NAME, scopes: ['read'] });
  expect((input as { expiresAt: Date }).expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(hash).not.toContain(token);
});

it('mints with the concierge\'s write scopes and the gate flag together, never one without the other', async () => {
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read', 'tasks', 'terminals']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ scopes: ['read', 'tasks', 'terminals'], gated: true });
});

it('gates the token even when asked to mint a narrower scope list', async () => {
  // gated:true is hardcoded in mintConciergeToken itself, not derived from the scopes it is given —
  // the dangerous combination (wide scopes, no gate) must be structurally impossible, not just untested.
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect((input as { gated: boolean }).gated).toBe(true);
});

it('revokes the previous token of the same conversation before minting, in one targeted call', async () => {
  // which rows that takes (this conversation only; the legacy null ones only for the account-wide chat)
  // is covered against Postgres in api-tokens.db.test.ts
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read']);
  expect(r.apiTokens.revokeLiveConcierge).toHaveBeenCalledWith('u1', 'c1', { accountWide: undefined });
  await mintConciergeToken(r, 'u1', 'c_wide', ['read'], { accountWide: true });
  expect(r.apiTokens.revokeLiveConcierge).toHaveBeenLastCalledWith('u1', 'c_wide', { accountWide: true });
  expect(r.apiTokens.revokeLiveConcierge.mock.invocationCallOrder[0]).toBeLessThan(r.apiTokens.create.mock.invocationCallOrder[0]);
});

it('stores the conversation, the origin and the conversation\'s project and machine on the token (TER-1191)', async () => {
  const r = repos();
  await mintConciergeToken(r, 'u1', 'c1', ['read'], { projectId: 'p1', machineId: 'm1' });
  const [, input] = r.apiTokens.create.mock.calls[0];
  expect(input).toMatchObject({ gated: true, chatConversationId: 'c1', origin: 'concierge', projectId: 'p1', machineId: 'm1' });
});
