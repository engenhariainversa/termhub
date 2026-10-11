import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { ApiTokenScope } from '../auth/api-tokens.js';
import { canAccess, type Action, type Resource } from '../auth/permissions.js';
import { Scoped, type Scope } from '../auth/scope.js';
import type { AttachmentStore } from '../chat/attachments/store.js';
import { LocalizedText } from '../i18n/index.js';

/** What every control operation runs with: the data scope of one user and their grants. */
export interface ControlContext {
  repos: Repositories;
  scope: Scope;
  scoped: Scoped;
  can(resource: Resource, action: Action): Promise<boolean>;
  /** The API token this request came in with, when it came through /mcp (absent for web sessions).
   * `gated` marks the chat concierge's token (rotated every run, see `closeTab`); `tab` marks an agent
   * tab's token (TER-212 D2–D5), pinned to that tab and its project. */
  token?: ControlToken;
  /** The chat-files store, for `read_attachment`; set by the MCP route, absent for web-session contexts. */
  attachments?: AttachmentStore;
  /** The request's logger, set by the MCP route: best-effort work a tool fires (e.g. `record_lesson`'s
   *  note re-index) logs through it — ids and codes only — instead of falling back to `console`. */
  log?: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  /** Set by the gate when the call runs a confirmation card the person clicked (`grant_id` null): what
   *  it types is then text they approved word for word (TER-851 `person_approved`). Never set by a grant. */
  approval?: { actionId: string; approvedAt: Date };
}

/** What a control operation knows of the /mcp token it runs under. */
export interface ControlToken {
  id: string;
  scopes: readonly ApiTokenScope[];
  gated?: boolean;
  tab?: { id: string; project_id: string };
  /** The chat conversation a concierge token was minted for (`recap_pending_cards`, TER-477). */
  chat_conversation_id?: string | null;
}

/** A user's own scope — never "view as", even for admins (API tokens act as their owner only). */
export function controlContextFor(repos: Repositories, user: User, token?: ControlToken): ControlContext {
  const scope: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, user, resource, action), token };
}

/** A route's control context: the request's own scope, "view as" included (routes, unlike tokens, honour it). */
export function controlContextForRequest(repos: Repositories, request: FastifyRequest): ControlContext {
  const scope = request.scope;
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, scope.user, resource, action) };
}

/** An expected failure the caller should see (actionable). `message` is the pt-BR rendering; the
 *  reply translates `localized` with the caller's language (`t(locale, err.localized)`). */
export class ControlError extends Error {
  /** Non-enumerable, so equality checks on the error (tests, logs) see only code and message. */
  declare readonly localized: LocalizedText;
  constructor(
    readonly code: string,
    message: string | LocalizedText,
  ) {
    const localized = message instanceof LocalizedText ? message : new LocalizedText(message);
    super(localized.toString());
    Object.defineProperty(this, 'localized', { value: localized, enumerable: false });
    this.name = 'ControlError';
  }
}
