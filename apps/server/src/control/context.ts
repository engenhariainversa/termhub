import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import type { ApiTokenScope } from '../auth/api-tokens.js';
import { canAccess, type Action, type Resource } from '../auth/permissions.js';
import { Scoped, type Scope } from '../auth/scope.js';
import type { AttachmentStore } from '../chat/attachments/store.js';

/** What every control operation runs with: the data scope of one user and their grants. */
export interface ControlContext {
  repos: Repositories;
  scope: Scope;
  scoped: Scoped;
  can(resource: Resource, action: Action): Promise<boolean>;
  /** The API token this request came in with, when it came through /mcp (absent for web sessions).
   * `gated` marks the chat concierge's token (rotated every run, see `closeTab`). */
  token?: { id: string; scopes: readonly ApiTokenScope[]; gated?: boolean };
  /** The chat-files store, for `read_attachment`; set by the MCP route, absent for web-session contexts. */
  attachments?: AttachmentStore;
}

/** A user's own scope — never "view as", even for admins (API tokens act as their owner only). */
export function controlContextFor(repos: Repositories, user: User, token?: { id: string; scopes: readonly ApiTokenScope[]; gated?: boolean }): ControlContext {
  const scope: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, user, resource, action), token };
}

/** An expected failure the caller should see (pt-BR, actionable). */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}
