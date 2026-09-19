import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { User } from '../db/repositories/types.js';
import { API_TOKEN_RE, hashApiToken } from '../auth/api-tokens.js';

/** Bearer token → its owner. Null for anything invalid; callers answer one constant 401. */
export async function authenticateToken(repos: Repositories, header: string | undefined): Promise<{ token: ApiToken; user: User } | null> {
  const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!API_TOKEN_RE.test(raw)) return null;
  const token = await repos.apiTokens.findActiveByHash(hashApiToken(raw));
  if (!token) return null;
  const user = await repos.users.findById(token.user_id);
  return user ? { token, user } : null;
}
