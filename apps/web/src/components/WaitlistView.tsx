import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Role, WaitlistEntry, WaitlistInviteResult } from '../lib/types';
import { ConfirmDialog, Modal } from './Modal';
import { formatDate, formatDateTime } from '../lib/format';

/**
 * Home "Waitlist" tab: sign-ups from the landing page's Cloud section.
 * Shown only to roles granted waitlist:read (see HomePage). Inviting (creating the user
 * and sending the alpha e-mail) needs users:create, like Settings → Usuários → Convidar.
 */

function csv(entries: WaitlistEntry[]): string {
  const cols = ['created_at', 'first_name', 'last_name', 'email', 'phone', 'linkedin', 'github', 'locale', 'invited_at'] as const;
  const esc = (v: string | null) => `"${(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...entries.map((e) => cols.map((c) => esc(e[c])).join(','))].join('\n');
}

const shortDate = (iso: string) => formatDate(iso);

/** Confirm + role picker for the alpha invite; shows each entry's outcome once sent. */
function InviteDialog({ entries, roles, onClose, onDone }: { entries: WaitlistEntry[]; roles: Role[]; onClose: () => void; onDone: (results: WaitlistInviteResult[]) => void }) {
  const [roleId, setRoleId] = useState(roles.find((r) => r.name === 'AUTHENTICATED')?.id ?? roles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<WaitlistInviteResult[] | null>(null);
  const many = entries.length > 1;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const { results } = await api.users.inviteFromWaitlist({ ids: entries.map((e) => e.id), role_id: roleId });
      setResults(results);
      onDone(results);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro ao convidar');
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map(entries.map((e) => [e.id, e]));
  const sent = results?.filter((r) => 'mail' in r && r.mail.sent).length ?? 0;

  return (
    <Modal title={many ? `Convidar ${entries.length} alpha testers` : 'Convidar alpha tester'} open onClose={onClose}>
      {!results ? (
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            Cria o usuário com a role escolhida (ou reaproveita a conta que já tem esse e-mail), libera o e-mail no Cloudflare Access quando configurado e envia o e-mail de alpha tester com o link do app e do grupo do WhatsApp, no idioma da inscrição.
          </p>
          <ul className="max-h-40 overflow-y-auto rounded-md border border-line bg-bg-3 px-3 py-2 text-sm">
            {entries.map((e) => (
              <li key={e.id} className="flex justify-between gap-3">
                <span>
                  {e.first_name} {e.last_name}
                </span>
                <span className="text-fg-muted">{e.email}</span>
              </li>
            ))}
          </ul>
          <div>
            <label className="label" htmlFor="waitlist-invite-role">
              Role
            </label>
            <select id="waitlist-invite-role" className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                  {r.is_admin ? ' (admin)' : ''}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="button" className="btn-primary" disabled={busy || !roleId} onClick={() => void send()}>
              {busy ? 'Enviando…' : many ? `Enviar convites (${entries.length})` : 'Enviar convite'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            {sent} convite{sent === 1 ? '' : 's'} enviado{sent === 1 ? '' : 's'} de {results.length}.
          </p>
          <ul className="max-h-60 overflow-y-auto rounded-md border border-line bg-bg-3 px-3 py-2 text-sm">
            {results.map((r) => {
              const e = byId.get(r.id);
              const label = e ? e.email : r.id;
              if ('error' in r)
                return (
                  <li key={r.id} className="text-danger">
                    {label}: {r.error}
                  </li>
                );
              const notes = [
                r.existing ? 'usuário já existia' : 'usuário criado',
                r.mail.sent ? 'e-mail enviado' : `e-mail falhou: ${r.mail.error ?? 'erro'}`,
                r.access.configured ? (r.access.synced ? 'Access liberado' : `Access falhou: ${r.access.error ?? 'erro'}`) : null,
              ].filter(Boolean);
              return (
                <li key={r.id} className={r.mail.sent ? '' : 'text-warn'}>
                  {label} — {notes.join(' · ')}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end pt-2">
            <button type="button" className="btn-primary" onClick={onClose}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function WaitlistView() {
  const { can } = useAuth();
  const canInvite = can('users', 'create');
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WaitlistEntry | null>(null);
  const [inviting, setInviting] = useState<WaitlistEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const load = () =>
    api.waitlist
      .list()
      .then((r) => {
        setEntries(r.entries);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Erro ao carregar a waitlist'));

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!canInvite) return;
    api.roles
      .list()
      .then((r) => setRoles(r.roles))
      .catch(() => setRoles([]));
  }, [canInvite]);

  const visible = (entries ?? []).filter((e) => {
    const q = filter.trim().toLowerCase();
    return !q || `${e.first_name} ${e.last_name} ${e.email} ${e.phone}`.toLowerCase().includes(q);
  });

  const download = () => {
    const blob = new Blob([csv(entries ?? [])], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `termhub-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Stamp the rows the server marked as invited (everything that did not come back as an error). */
  const onInvited = (results: WaitlistInviteResult[]) => {
    const ok = new Set(results.filter((r) => !('error' in r)).map((r) => r.id));
    const now = new Date().toISOString();
    setEntries((l) => (l ?? []).map((e) => (ok.has(e.id) ? { ...e, invited_at: now } : e)));
    setSelected(new Set());
  };

  return (
    <div>
      <div className="mb-5 flex items-end gap-4">
        <div>
          <h2 className="text-lg font-semibold">Waitlist do Cloud</h2>
          <p className="text-sm text-fg-muted">{entries ? `${entries.length} inscrito(s) pela landing page` : 'Carregando…'}</p>
        </div>
        <span className="ml-auto flex items-center gap-2">
          {canInvite && selected.size > 0 && (
            <button className="btn-primary text-xs" onClick={() => setInviting((entries ?? []).filter((e) => selected.has(e.id)))}>
              Convidar selecionados ({selected.size})
            </button>
          )}
          <input className="input w-48 py-1 text-xs" placeholder="filtrar…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn-ghost text-xs" onClick={download} disabled={!entries?.length}>
            ↓ CSV
          </button>
          <button className="btn-ghost text-xs" onClick={() => void load()} title="Recarregar">
            ↻
          </button>
        </span>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {entries && entries.length === 0 && <p className="text-sm text-fg-dim">Ninguém ainda. O formulário fica na seção Cloud da landing page.</p>}
      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                {canInvite && <th className="w-8 px-3 py-2" />}
                <th className="px-3 py-2">Quando</th>
                <th className="px-3 py-2">Nome</th>
                <th className="px-3 py-2">E-mail</th>
                <th className="px-3 py-2">Telefone</th>
                <th className="px-3 py-2">Links</th>
                <th className="px-3 py-2">Idioma</th>
                <th className="px-3 py-2">Convite</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-bg-3">
                  {canInvite && (
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} aria-label={`Selecionar ${e.email}`} />
                    </td>
                  )}
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-dim">{formatDateTime(e.created_at)}</td>
                  <td className="px-3 py-2">
                    {e.first_name} {e.last_name}
                  </td>
                  <td className="px-3 py-2">
                    <a href={`mailto:${e.email}`} className="hover:underline">
                      {e.email}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{e.phone}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.linkedin && (
                      <a href={e.linkedin} target="_blank" rel="noreferrer" className="mr-2 text-accent hover:underline">
                        LinkedIn
                      </a>
                    )}
                    {e.github && (
                      <a href={e.github} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        GitHub
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs uppercase text-fg-dim">{e.locale}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">
                    {e.invited_at ? <span className="text-ok">Convidado em {shortDate(e.invited_at)}</span> : <span className="text-fg-dim">—</span>}
                    {canInvite && (
                      <button className="btn-ghost ml-2 px-2 py-0.5 text-xs" onClick={() => setInviting([e])}>
                        {e.invited_at ? 'Reenviar' : 'Convidar'}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title="Remover" onClick={() => setDeleting(e)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteDialog entries={inviting} roles={roles} onClose={() => setInviting(null)} onDone={onInvited} />}
      <ConfirmDialog
        open={!!deleting}
        title="Remover da waitlist"
        message={
          <>
            Remover <strong>{deleting?.email}</strong> da lista?
          </>
        }
        confirmLabel="Remover"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.waitlist.remove(deleting.id);
            setEntries((l) => (l ?? []).filter((x) => x.id !== deleting.id));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao remover');
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}
