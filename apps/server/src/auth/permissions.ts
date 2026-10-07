import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';

/** Resource catalog: what the permission matrix shows and what routes are guarded by. */
export const RESOURCES = [
  { key: 'machines', label: 'Máquinas' },
  { key: 'projects', label: 'Projetos' },
  { key: 'terminals', label: 'Terminais' },
  { key: 'tasks', label: 'Tarefas' },
  { key: 'notes', label: 'Notas' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'integrations', label: 'Integrações' },
  { key: 'ai_accounts', label: 'Contas de IA' },
  { key: 'hardware', label: 'Hardware' },
  { key: 'uploads', label: 'Arquivos enviados' },
  { key: 'api_tokens', label: 'Tokens de API' },
  { key: 'waitlist', label: 'Waitlist' },
  { key: 'users', label: 'Usuários' },
  { key: 'roles', label: 'Roles e permissões' },
  { key: 'chat', label: 'Chat' },
  { key: 'devices', label: 'Aparelhos' },
  { key: 'security_events', label: 'Auditoria de segurança' },
] as const;
export type Resource = (typeof RESOURCES)[number]['key'];
// 'write' is used only by the `terminals` resource: acting inside a terminal or simulator — typing over
// /ws/tabs, tapping over /ws/sim, POST /tabs/:id/input and /paste-file (TER-576), the mobile write routes and
// the MCP write tools (open_tab, send_input, send_key, run_command, close_tab). That isn't CRUD on a record, so
// it gets its own action rather than overloading 'update'; terminals:read alone only watches.
export const ACTIONS = ['create', 'read', 'update', 'delete', 'write'] as const;
export type Action = (typeof ACTIONS)[number];
export const RESOURCE_KEYS: readonly string[] = RESOURCES.map((r) => r.key);

export const isResource = (v: string): v is Resource => RESOURCE_KEYS.includes(v);
export const isAction = (v: string): v is Action => (ACTIONS as readonly string[]).includes(v);

/**
 * Whether a resource/action pair is a grant that can actually exist: the four CRUD actions are valid for
 * every resource, but 'write' is valid only for 'terminals' (the MCP write tools are not CRUD on a record).
 * The one place this is checked — the permissions toggle route, the matrix the settings page reads, and the
 * admin's flat grant list all call this instead of repeating the condition.
 */
export function isValidGrant(resource: Resource, action: Action): boolean {
  return action === 'write' ? resource === 'terminals' : true;
}

/** HTTP method -> default action for routes that only set a resource. */
export function actionForMethod(method: string): Action {
  switch (method.toUpperCase()) {
    case 'POST':
      return 'create';
    case 'PATCH':
    case 'PUT':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'read';
  }
}

interface RoleGrant {
  isAdmin: boolean;
  set: Set<string>;
  at: number;
}

const CACHE_MS = 30_000;
const cache = new Map<string, RoleGrant>();

/** Drop the cached grants (after a permission or role change). */
export function invalidatePermissionCache(roleId?: string): void {
  if (roleId) cache.delete(roleId);
  else cache.clear();
}

async function grants(repos: Repositories, roleId: string): Promise<RoleGrant> {
  const hit = cache.get(roleId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const role = await repos.roles.findById(roleId);
  const perms = role ? await repos.roles.permissionsOf(roleId) : [];
  const g: RoleGrant = { isAdmin: !!role?.is_admin, set: new Set(perms.map((p) => `${p.resource}:${p.action}`)), at: Date.now() };
  cache.set(roleId, g);
  return g;
}

/** Admin roles pass everything; other roles need an explicit grant. Users without a role have no grants. */
export async function canAccess(repos: Repositories, user: User | null | undefined, resource: string, action: string): Promise<boolean> {
  if (!user?.role_id) return false;
  const g = await grants(repos, user.role_id);
  if (g.isAdmin) return true;
  return g.set.has(`${resource}:${action}`);
}

/** Whether the user's role bypasses the permission matrix (also unlocks the "view as" scope switch). */
export async function isAdmin(repos: Repositories, user: User | null | undefined): Promise<boolean> {
  if (!user?.role_id) return false;
  return (await grants(repos, user.role_id)).isAdmin;
}

/** Flat "resource:action" list for the client (admins get the full catalog). */
export async function permissionsOf(repos: Repositories, user: User): Promise<string[]> {
  if (!user.role_id) return [];
  const g = await grants(repos, user.role_id);
  if (g.isAdmin) return RESOURCES.flatMap((r) => ACTIONS.filter((a) => isValidGrant(r.key, a)).map((a) => `${r.key}:${a}`));
  return [...g.set].sort();
}
