import type { Repositories } from '../db/repositories/index.js';
import type { ApiToken } from '../db/repositories/api-tokens.js';
import type { User } from '../db/repositories/types.js';
import { isPendingDeletion } from '../account/deletion.js';
import { API_TOKEN_RE, hashApiToken } from '../auth/api-tokens.js';

/**
 * Bearer token → its owner, and for a tab token (TER-212) the tab it is pinned to. Null for anything
 * invalid; callers answer one constant 401. A tab token whose tab row is gone is refused here too (D6):
 * the close paths revoke it in the tab's own transaction, and this makes "tab gone ⇒ token dead" hold
 * even for a delete that bypasses them (the machine delete cascade, say).
 */
export async function authenticateToken(
  repos: Repositories,
  header: string | undefined,
): Promise<{ token: ApiToken; user: User; tab: { id: string; project_id: string } | null } | null> {
  const raw = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!API_TOKEN_RE.test(raw)) return null;
  const token = await repos.apiTokens.findActiveByHash(hashApiToken(raw));
  if (!token) return null;
  let tab: { id: string; project_id: string } | null = null;
  if (token.tab_id) {
    // A tab token is never gated (D2, §6): `mintTabToken` never makes one, and a row that says otherwise is refused.
    if (token.gated) return null;
    const row = await repos.tabs.findById(token.tab_id);
    if (!row) return null;
    tab = { id: row.id, project_id: row.project_id };
  }
  const user = await repos.users.findById(token.user_id);
  // A deactivated account (deletion pending, TER-720): its tokens stay, refused until a cancel.
  if (!user || isPendingDeletion(user)) return null;
  return { token, user, tab };
}
