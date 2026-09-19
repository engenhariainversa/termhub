import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { canAccess, type Action, type Resource } from '../auth/permissions.js';
import { Scoped, type Scope } from '../auth/scope.js';

/** What every control operation runs with: the data scope of one user and their grants. */
export interface ControlContext {
  repos: Repositories;
  scope: Scope;
  scoped: Scoped;
  can(resource: Resource, action: Action): Promise<boolean>;
}

/** A user's own scope — never "view as", even for admins (API tokens act as their owner only). */
export function controlContextFor(repos: Repositories, user: User): ControlContext {
  const scope: Scope = { user, viewAs: { kind: 'self' }, ownerId: user.id, createAs: user.id };
  return { repos, scope, scoped: new Scoped(repos, scope), can: (resource, action) => canAccess(repos, user, resource, action) };
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
