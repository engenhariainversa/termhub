import type { TaskStatus } from '../db/repositories/types.js';

const PROVIDERS = new Set(['github', 'linear', 'jira']);

/** A card's link to its external ticket, as read from `tasks.external_ref`. */
export interface TicketLink {
  provider: 'github' | 'linear' | 'jira';
  key: string;
  provider_id: string;
  url: string;
  state: string;
  status: TaskStatus;
  scope: string | null;
  integration_id: string | null;
}

/**
 * The JSON stored in `tasks.external_ref`. `identifier` and `id` repeat `key` and `provider_id`
 * because the previous release reads those names (deploy window and rollback).
 */
export function ticketLinkJson(
  t: { provider: TicketLink['provider']; provider_id: string; key: string; url: string; state: string; status: TaskStatus; updated_at?: string; meta?: Record<string, unknown> },
  source: { integration_id: string; scope: string },
): Record<string, unknown> {
  return {
    ...(t.meta ?? {}),
    provider: t.provider,
    key: t.key,
    identifier: t.key,
    provider_id: t.provider_id,
    id: t.provider_id,
    url: t.url,
    state: t.state,
    status: t.status,
    scope: source.scope,
    integration_id: source.integration_id,
    ...(t.updated_at ? { updated_at: t.updated_at } : {}),
  };
}

/** The provider's own id, from the sync key: the issue number (GitHub), the issue id (Linear), the key (Jira). */
export function providerIdOf(t: { provider: TicketLink['provider']; sync_key: string }): string {
  if (t.provider === 'github') return t.sync_key.split('#').pop() ?? t.sync_key;
  return t.sync_key.slice(t.sync_key.indexOf(':') + 1);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Reads links from both releases; a legacy GitHub `#12` becomes `owner/repo#12` from its scope. */
export function readTicketLink(ref: unknown): TicketLink | null {
  if (!ref || typeof ref !== 'object') return null;
  const r = ref as Record<string, unknown>;
  const provider = str(r.provider);
  if (!provider || !PROVIDERS.has(provider)) return null;
  const scope = str(r.scope);
  const legacy = str(r.identifier);
  const key = str(r.key) ?? (provider === 'github' && legacy?.startsWith('#') && scope ? `${scope}${legacy}` : legacy);
  const providerId = str(r.provider_id) ?? str(r.id);
  if (!key || !providerId) return null;
  return {
    provider: provider as TicketLink['provider'],
    key,
    provider_id: providerId,
    url: str(r.url) ?? '',
    state: str(r.state) ?? '',
    status: (str(r.status) ?? 'backlog') as TaskStatus,
    scope,
    integration_id: str(r.integration_id),
  };
}
