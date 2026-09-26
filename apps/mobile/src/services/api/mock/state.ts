// The mock "server"'s in-memory rows (design spec §4.2) and the `verify()` helper shared by
// every authenticated route. Nothing here is persisted: a fresh `createMockState()` is a fresh
// server, which is the point (§4.2's closing paragraph — a stale device must behave like a
// revoked one, not like a 404).
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from '../../crypto/encoding';
import type { P256Jwk } from '../../key/types';
import { verifyProof } from '../dpop';
import type { TChatAction, TChatAttachment, TChatConversation, TChatGrant, TChatMessage, TDeviceInfo, TNotificationRow, TTabQuestion, TTabSuggestion } from '../contract';

/** Every non-2xx answer the mock throws (design spec ruling): mapped to the wire shape by
 * `transport.ts`. `error` is pt-BR text; `extra` carries `attempts_left` / `retry_after`, spread
 * into the body verbatim and mirrored onto a `Retry-After` header when `retry_after` is present. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly error: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(error);
    this.name = 'WireError';
  }
}

export type MockDeviceRequestStatus = 'pending' | 'approved' | 'denied' | 'activated';

export interface MockDeviceRequest {
  id: string;
  email: string;
  publicKey: P256Jwk;
  device: TDeviceInfo;
  appVersion: string;
  /** sha256 hex of the request secret — the secret itself is never stored (ruling 8). */
  secretHash: string;
  code: string;
  status: MockDeviceRequestStatus;
  createdAt: number;
  expiresAt: number;
  /** Set once `approve()` moves the row to `approved`; undefined before that. */
  activateUntil?: number;
}

export interface MockDevice {
  id: string;
  userId: string;
  email: string;
  jwk: P256Jwk;
  pinSecret: Uint8Array;
  pinFailures: number;
  lockedUntil?: number;
  status: 'active' | 'revoked';
  revokedReason?: string;
  pushToken?: string;
  name: string;
  platform: 'ios' | 'android';
  model: string;
  os: string;
  createdAt: number;
}

export interface MockToken {
  deviceId: string;
  expiresAt: number;
}

export interface MockChallenge {
  deviceId: string;
  purpose: 'refresh' | 'decision';
  actionId?: string;
  expiresAt: number;
  used: boolean;
}

/** The fake socket (`mock/socket.ts`): registered in `state.sockets` for the lifetime of one
 * upgraded connection, so `broadcast`, `revokeDevice` and `controls.dropSocket` can all reach it
 * without knowing anything about the transport underneath. */
export interface MockSocket {
  deviceId: string;
  send(event: unknown): void;
  close(code: number): void;
}

/** `chat/projects`' rows minus the derived fields (`busy`, `pending_confirmations`,
 * `last_message_at`) — those are computed from `conversations`/`actions`/`busyProjects` at
 * request time rather than kept in sync by hand. */
export interface MockProject {
  id: string;
  name: string;
  key: string;
}

/** Field-for-field the wire shape of `ChatConversation` (contract `local.ts`) — the mock never
 * needs anything the app itself does not see. */
export type MockConversation = TChatConversation;

/** Field-for-field the wire shape of `ChatMessage` (contract `events.ts`). */
export type MockMessage = TChatMessage;

/** The wire shape of `ChatAction` (contract `local.ts`) plus `conversation_id`, which the app
 * never needs (actions arrive already scoped to one conversation) but the mock does, to route
 * `decision` events and to filter `GET chat`'s `actions` array. */
export interface MockAction extends TChatAction {
  conversation_id: string;
}

/** A trusted tab ("Permitir sempre nesta aba"): the wire shape plus what the server keeps beside
 * it — the conversation it belongs to and whether it was revoked. `GET chat` lists the ones of
 * that conversation still in force (not revoked, not expired). */
export interface MockGrant extends TChatGrant {
  conversation_id: string;
  revoked: boolean;
  /** When and whether a person revoked it — a reset revokes with `revoked_by_user: false`. */
  revoked_at: string | null;
  revoked_by_user: boolean;
}

/** Field-for-field the wire shape of a notification row (contract `notifications.ts`). */
export type MockNotification = TNotificationRow;

/** A tab's question (spec 2026-09-25): the wire shape plus the conversation it was pushed into. */
export type MockTabQuestion = TTabQuestion & { conversation_id: string };

/** A tab's suggestion (spec 2026-09-25 tab suggestions): the wire shape plus the conversation it was pushed into. */
export type MockTabSuggestion = TTabSuggestion & { conversation_id: string };

/** An uploaded file (spec 2026-09-26): the wire shape plus what the server keeps beside it. */
export interface MockAttachment extends TChatAttachment {
  conversation_id: string;
  /** Set by the send that carried it; a sent attachment can neither be deleted nor sent again. */
  message_id: string | null;
}

/** A voice clip accepted by `POST transcriptions`: "transcribed" on its second poll. */
export interface MockTranscription {
  id: string;
  seconds: number;
  polls: number;
}

export interface MockState {
  requests: Map<string, MockDeviceRequest>;
  devices: Map<string, MockDevice>;
  tokens: Map<string, MockToken>;
  challenges: Map<string, MockChallenge>;
  /** Per-device jti window (P§5.2: replayed within 5 minutes is refused), value is the `iat`
   * (seconds) the jti was first seen at, used to prune entries older than the window. */
  jtis: Map<string, Map<string, number>>;
  sockets: Set<MockSocket>;

  projects: Map<string, MockProject>;
  conversations: Map<string, MockConversation>;
  /** Conversation id -> its messages, oldest first. */
  messages: Map<string, MockMessage[]>;
  actions: Map<string, MockAction>;
  /** Oldest first; revoked rows stay (a second revoke is a 409, as on the server). */
  grants: MockGrant[];
  /** Oldest first; answered rows stay (a second answer is a 409, as on the server). */
  tabQuestions: MockTabQuestion[];
  /** Oldest first; closed rows stay (a second send is a 409, as on the server). */
  tabSuggestions: MockTabSuggestion[];
  attachments: Map<string, MockAttachment>;
  transcriptions: Map<string, MockTranscription>;
  /** Oldest first (push order); routes read it newest-first by reversing. */
  notifications: MockNotification[];
  /** The conversation currently "live" for a project (or, keyed by `null`, the account-wide
   * chat) — what `reset` swaps and every chat route reads to find "the" conversation. */
  activeConversation: Map<string | null, string>;
  /** Projects (or `null` for the account-wide chat) with a streaming reply in flight. */
  busyProjects: Set<string | null>;
}

export function createMockState(): MockState {
  return {
    requests: new Map(),
    devices: new Map(),
    tokens: new Map(),
    challenges: new Map(),
    jtis: new Map(),
    sockets: new Set(),
    projects: new Map(),
    conversations: new Map(),
    messages: new Map(),
    actions: new Map(),
    grants: [],
    tabQuestions: [],
    tabSuggestions: [],
    attachments: new Map(),
    transcriptions: new Map(),
    notifications: [],
    activeConversation: new Map(),
    busyProjects: new Set(),
  };
}

/** Sends `event` to every open socket — there is only one mock user, so no per-user filtering is
 * needed (design spec §4.2 "Events"). */
export function broadcast(state: MockState, event: unknown): void {
  for (const socket of state.sockets) socket.send(event);
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** sha256 hex of a UTF-8 string — used to hash request secrets and access tokens for lookups
 * without ever keeping the clear value (ruling 8). */
export const sha256Hex = (s: string): string => toHex(sha256(utf8(s)));

export function bearerToken(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization;
  if (!auth) return undefined;
  const m = /^Bearer (.+)$/.exec(auth);
  return m?.[1];
}

/** The externally-visible poll status (P§4.5): `denied`/`activated` and any expiry collapse to
 * `closed`, so a decoy and a real row are indistinguishable to whoever holds the secret. */
export function requestStatus(req: MockDeviceRequest, now: number): 'pending' | 'approved' | 'closed' {
  if (req.status === 'pending') return now > req.expiresAt ? 'closed' : 'pending';
  if (req.status === 'approved') return req.activateUntil !== undefined && now <= req.activateUntil ? 'approved' : 'closed';
  return 'closed';
}

/** Prunes jtis older than the 5-minute window, then claims `jti` for `deviceId` — returns `false`
 * on a replay (P§5.2). */
export function claimJti(state: MockState, deviceId: string, jti: string, nowSeconds: number): boolean {
  let bucket = state.jtis.get(deviceId);
  if (!bucket) {
    bucket = new Map();
    state.jtis.set(deviceId, bucket);
  }
  for (const [seenJti, seenAt] of bucket) {
    if (nowSeconds - seenAt > 300) bucket.delete(seenJti);
  }
  if (bucket.has(jti)) return false;
  bucket.set(jti, nowSeconds);
  return true;
}

export type VerifiedAuth = { device: MockDevice; token: string };

/**
 * The generic authenticated-route check (`me`, `devices/self`, `devices/self/revoke`,
 * `push-token`): bearer → token row, device (revoked or missing alike answer `DEVICE_REVOKED`),
 * DPoP (bound to the token's `ath`), then the jti window — in that order (brief ruling), unlike
 * `session/token`'s order where the signature is checked before the device's revoked status.
 */
export function verifyAuth(state: MockState, ctx: { headers: Record<string, string>; htm: string; htu: string; now: number }): VerifiedAuth {
  const bearer = bearerToken(ctx.headers);
  const tokenRow = bearer ? state.tokens.get(bearer) : undefined;
  if (!bearer || !tokenRow || tokenRow.expiresAt <= ctx.now) {
    throw new WireError(401, 'TOKEN_EXPIRED', 'Sessão expirada.');
  }

  const device = state.devices.get(tokenRow.deviceId);
  if (!device || device.status === 'revoked') {
    throw new WireError(401, 'DEVICE_REVOKED', 'Este aparelho foi removido da conta.');
  }

  const nowSeconds = Math.floor(ctx.now / 1000);
  const ath = b64url(sha256(utf8(bearer)));
  const dpop = ctx.headers.dpop;
  const result = dpop ? verifyProof(dpop, { htm: ctx.htm, htu: ctx.htu, now: nowSeconds, jwk: device.jwk, ath }) : undefined;
  if (!result || !result.ok) throw new WireError(401, 'PROOF_INVALID', 'Prova de posse inválida.');

  if (!claimJti(state, device.id, result.jti, nowSeconds)) {
    throw new WireError(401, 'PROOF_REPLAYED', 'Prova repetida.');
  }

  return { device, token: bearer };
}

/** Revokes one device and closes its (and only its) sockets with `4401` (P§5.5, P§5.7). Its
 * token rows stay, as on the server until the hourly purge: `verifyAuth` refuses them by the
 * device's status, so the next call — or socket upgrade — answers `DEVICE_REVOKED` rather than
 * an expired token. Shared by the brute-force lockout path and `controls.revokeNow`. */
export function revokeDevice(state: MockState, device: MockDevice, reason: string): void {
  device.status = 'revoked';
  device.revokedReason = reason;
  for (const socket of state.sockets) {
    if (socket.deviceId === device.id) socket.close(4401);
  }
}

export const PIN_LOCK_MS = 15 * 60_000;
const PIN_LOCK_AT = 3;
const PIN_REVOKE_AT = 6;

/** `max(0, 3 - failures)` for the first three failures, then the same shape again for the second
 * window (4, 5) once the lock has expired — i.e. 0 exactly on the failure that (re)triggers a
 * lock or a revoke, never a stray 3. */
export function pinAttemptsLeft(failures: number): number {
  const remainder = failures % PIN_LOCK_AT;
  return remainder === 0 ? 0 : PIN_LOCK_AT - remainder;
}

/** Counts one wrong PIN proof against `device`: locks at 3 failures for 15 min, revokes at 6
 * (P§5.5). Shared by `session/token` and `chat/actions/:id/decision`'s approve path — both are
 * places a PIN guess can be submitted, so both must burn the same budget. Returns the
 * `attempts_left` to report on the `401`. */
export function countPinFailure(state: MockState, device: MockDevice, now: number): number {
  device.pinFailures += 1;
  if (device.pinFailures >= PIN_REVOKE_AT) {
    revokeDevice(state, device, 'pin_bruteforce');
  } else if (device.pinFailures === PIN_LOCK_AT) {
    device.lockedUntil = now + PIN_LOCK_MS;
  }
  return pinAttemptsLeft(device.pinFailures);
}
