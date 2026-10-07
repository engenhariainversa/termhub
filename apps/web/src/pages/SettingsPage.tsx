import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { i18n, tk, Trans, useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AccessStatus, InviteResult, PermissionAction, ResourcePermissions, Role, User } from '../lib/types';
import { DEFAULT_SETTINGS_SECTION, visibleSettingsSections } from '../lib/settings-sections';
import { ConfirmDialog, Modal } from '../components/Modal';
import { UploadsView } from '../components/UploadsView';
import { ApiTokensView } from '../components/ApiTokensView';
import { DevicesView } from '../components/DevicesView';
import { ReviewAccountPanel } from '../components/ReviewAccountPanel';
import { MyCityView } from '../components/MyCityView';
import { ProfileView } from '../components/ProfileView';
import { IntegrationsView } from '../components/IntegrationsView';
import { AiAccountsView } from '../components/AiAccountsView';
import { HardwareView } from '../components/HardwareView';
import { WaitlistView } from '../components/WaitlistView';
import { ChatGrantsView } from '../components/ChatGrantsView';
import { SecurityEventsView } from '../components/SecurityEventsView';
import { PageFrame } from '../components/PageHeader';
import { formatDate, formatDateTime } from '../lib/format';

/**
 * Configurações' content: one section per address, each under the shared page header. The section
 * list itself is the settings sidebar (components/SettingsSidebar). Perfil, Minha cidade and
 * Integrações are the account's own; users, roles, the permission matrix (resource ×
 * create/read/update/delete) and uploads are administration. Same model as the engenhariainversa
 * CMS: admin roles bypass everything, system roles cannot be deleted.
 */

const ACTION_LABELS: Record<PermissionAction, string> = { create: tk('Criar'), read: tk('Ver'), update: tk('Editar'), delete: tk('Excluir') };
const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete'];

export function SettingsPage() {
  const { t } = useTranslation();
  const { section } = useParams<{ section?: string }>();
  const { can } = useAuth();
  const current = visibleSettingsSections(can).find((s) => s.key === section);
  // `/settings`, an unknown address or a section this role cannot see: Perfil, which everyone sees
  if (!current) return <Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />;

  switch (current.key) {
    case 'users':
      return <UsersSection />;
    case 'roles':
      return <RolesSection />;
    case 'integrations':
      return <IntegrationsView />;
    case 'ai':
      return (
        <PageFrame title={t(current.label)}>
          <AiAccountsView />
        </PageFrame>
      );
    case 'hardware':
      return (
        <PageFrame title={t(current.label)}>
          <HardwareView />
        </PageFrame>
      );
    case 'waitlist':
      return (
        <PageFrame title={t(current.label)}>
          <WaitlistView />
        </PageFrame>
      );
    case 'chat-grants':
      return (
        <PageFrame title={t(current.label)}>
          <ChatGrantsView />
        </PageFrame>
      );
    case 'permissions':
      return (
        <PageFrame title={t(current.label)}>
          <PermissionsSection />
        </PageFrame>
      );
    case 'uploads':
      return (
        <PageFrame title={t(current.label)}>
          <UploadsView />
        </PageFrame>
      );
    case 'security':
      return (
        <PageFrame title={t(current.label)}>
          <SecurityEventsView />
        </PageFrame>
      );
    case 'api-tokens':
      return (
        <PageFrame title={t(current.label)}>
          <ApiTokensView />
        </PageFrame>
      );
    case 'devices':
      return (
        <PageFrame title={t(current.label)}>
          <DevicesView />
        </PageFrame>
      );
    case 'city':
      return (
        <PageFrame title={t(current.label)}>
          <MyCityView />
        </PageFrame>
      );
    case 'profile':
      return (
        <PageFrame title={t(current.label)}>
          <ProfileView />
        </PageFrame>
      );
  }
}

// ── Users ────────────────────────────────────────────────────────────────────

/** Human summary of what an invite (or resend) managed to do. */
function inviteSummary(r: InviteResult): { text: string; warn: boolean } {
  const parts: string[] = [];
  let warn = false;
  if (r.access.configured) {
    if (r.access.synced) parts.push(i18n.t('liberado no Cloudflare Access'));
    else {
      parts.push(i18n.t('não foi liberado no Cloudflare Access ({{error}})', { error: r.access.error ?? i18n.t('erro') }));
      warn = true;
    }
  }
  if (r.mail.sent) parts.push(i18n.t('e-mail de convite enviado'));
  else {
    parts.push(i18n.t('e-mail não enviado ({{error}})', { error: r.mail.error ?? i18n.t('erro') }));
    warn = true;
  }
  return { text: `${r.user.email}: ${parts.join(', ')}.`, warn };
}

function InviteForm({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: (r: InviteResult) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(roles.find((r) => r.name === 'AUTHENTICATED')?.id ?? roles[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api.users.invite({ email: email.trim(), name: name.trim() || undefined, role_id: roleId }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao convidar'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t('Convidar usuário')} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-fg-muted">{t('O usuário é criado com a role escolhida, o e-mail é liberado no Cloudflare Access (quando configurado) e recebe um convite. Ele entra com Google ou com o código enviado por e-mail.')}</p>
        <div>
          <label className="label">{t('E-mail')}</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder={t('pessoa@exemplo.com')} />
        </div>
        <div>
          <label className="label">{t('Nome (opcional)')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Como aparece no app')} />
        </div>
        <div>
          <label className="label">{t('Role')}</label>
          <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
                {r.is_admin ? t(' (admin)') : ''}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy || !roleId}>
            {busy ? t('Convidando…') : t('Convidar')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function UsersSection() {
  const { t } = useTranslation();
  const { user: me, can } = useAuth();
  const [users, setUsers] = useState<User[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [access, setAccess] = useState<AccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [resending, setResending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);
  const [reviewing, setReviewing] = useState<User | null>(null);

  const loadAccess = useCallback(async () => {
    try {
      setAccess(await api.users.access());
    } catch {
      setAccess(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.users.list(), api.roles.list()]);
      setUsers(u.users);
      setRoles(r.roles);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao carregar'));
    }
    void loadAccess();
  }, [loadAccess, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const allowed = useMemo(() => new Set((access?.emails ?? []).map((e) => e.toLowerCase())), [access]);

  const setRole = async (u: User, roleId: string) => {
    try {
      const r = await api.users.setRole(u.id, roleId);
      setUsers((l) => (l ?? []).map((x) => (x.id === u.id ? r.user : x)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao alterar a role'));
    }
  };

  const onInvited = (r: InviteResult) => {
    setInviting(false);
    setUsers((l) => [...(l ?? []), r.user]);
    setNotice(inviteSummary(r));
    void loadAccess();
  };

  const resend = async (u: User) => {
    setResending(u.id);
    try {
      setNotice(inviteSummary(await api.users.resendInvite(u.id)));
      void loadAccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao reenviar o convite'));
    } finally {
      setResending(null);
    }
  };

  const accessCell = (u: User) => {
    if (!access) return <span className="text-fg-dim">…</span>;
    if (!access.configured) return <span className="text-fg-dim" title={t('CF_ACCOUNT_ID / CF_API_TOKEN não configurados')}>—</span>;
    if (access.error) return <span className="text-danger" title={access.error}>{t('erro')}</span>;
    return allowed.has(u.email.toLowerCase()) ? (
      <span className="text-ok" title={t('Liberado em {{domain}}', { domain: access.domain })}>{t('✓ liberado')}</span>
    ) : (
      <span className="text-warn" title={t('Não está na policy {{policy}} de {{domain}}', { policy: access.policy, domain: access.domain })}>{t('não liberado')}</span>
    );
  };

  return (
    <PageFrame
      title={t('Usuários')}
      actions={
        can('users', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setInviting(true)}>
            {t('Convidar')}
          </button>
        )
      }
    >
    <div>
      <p className="mb-4 text-sm text-fg-muted">
        {users ? t('{{count}} usuários.', { count: users.length }) : t('Carregando…')}{' '}
        {t('Convide pelo e-mail: o usuário entra com Google ou com o código enviado por e-mail.')}
        {access?.configured && (
          <>
            {' '}
            <Trans
              i18nKey="Convites também liberam o e-mail no Cloudflare Access de <0>{{domain}}</0>."
              values={{ domain: access.domain }}
              components={[<code key="domain" className="font-mono text-xs" />]}
            />
          </>
        )}
      </p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {notice && (
        <p className={`mb-3 flex items-start gap-2 rounded border px-3 py-2 text-sm ${notice.warn ? 'border-warn/40 bg-warn/10 text-warn' : 'border-ok/40 bg-ok/10 text-ok'}`}>
          <span className="flex-1">{notice.text}</span>
          <button className="text-xs opacity-70 hover:opacity-100" onClick={() => setNotice(null)}>
            ✕
          </button>
        </p>
      )}
      {users && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-3 py-2">{t('Nome')}</th>
                <th className="px-3 py-2">{t('E-mail')}</th>
                <th className="px-3 py-2">{t('Login')}</th>
                <th className="px-3 py-2">{t('Access')}</th>
                <th className="px-3 py-2">{t('Role')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {u.avatar_url ? <img src={u.avatar_url} alt="" className="h-5 w-5 rounded-full" referrerPolicy="no-referrer" /> : <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-4 text-[10px]">{u.name[0]?.toUpperCase()}</span>}
                      {u.name}
                      {u.id === me?.id && <span className="text-[10px] text-fg-dim">{t('(você)')}</span>}
                      {u.invited_at && !u.last_login_at && (
                        <span className="rounded bg-bg-4 px-1.5 py-0.5 text-[10px] text-fg-dim" title={t('Convidado em {{date}}', { date: formatDateTime(u.invited_at) })}>
                          {t('convite pendente')}
                        </span>
                      )}
                      {u.deletion_scheduled_at && (
                        <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger" title={t('A pessoa pediu para excluir a conta; ela está desativada até lá')}>
                          {t('Exclusão em {{date}}', { date: formatDate(u.deletion_scheduled_at) })}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-muted">{u.email}</td>
                  <td className="px-3 py-2 text-xs text-fg-dim">
                    {[u.has_google && 'Google', u.has_password && t('senha'), t('e-mail')].filter(Boolean).join(' · ')}
                  </td>
                  <td className="px-3 py-2 text-xs">{accessCell(u)}</td>
                  <td className="px-3 py-2">
                    {can('users', 'update') ? (
                      <select className="input w-auto py-1 text-xs" value={u.role_info?.id ?? ''} onChange={(e) => void setRole(u, e.target.value)}>
                        {!u.role_info && <option value="">{t('— sem role —')}</option>}
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs">{u.role_info?.label ?? '—'}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {me?.role_info?.is_admin && (
                      <button className="mr-1 rounded px-1.5 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg" title={t('Modo revisão (store review)')} onClick={() => setReviewing(u)}>
                        {t('Revisão')}
                      </button>
                    )}
                    {can('users', 'update') && u.id !== me?.id && (
                      <button
                        className="mr-1 rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-fg disabled:opacity-50"
                        title={t('Reenviar convite (e-mail + Cloudflare Access)')}
                        disabled={resending === u.id}
                        onClick={() => void resend(u)}
                      >
                        {resending === u.id ? '…' : '↻'}
                      </button>
                    )}
                    {can('users', 'delete') && u.id !== me?.id && (
                      <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-4 hover:text-danger" title={t('Excluir')} onClick={() => setDeleting(u)}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {inviting && <InviteForm roles={roles} onClose={() => setInviting(false)} onDone={onInvited} />}
      <ConfirmDialog
        open={!!deleting}
        title={t('Excluir usuário')}
        message={
          access?.configured ? (
            <Trans
              i18nKey="Excluir <0>{{email}}</0> agora? Tudo o que é dele também é excluído: máquinas (o agente é desconectado), projetos, abas, chats, memória, integrações, contas de IA e tokens. As sessões dele são encerradas e o e-mail sai do Cloudflare Access. Não dá para desfazer."
              values={{ email: deleting?.email ?? '' }}
              components={[<strong key="email" />]}
            />
          ) : (
            <Trans
              i18nKey="Excluir <0>{{email}}</0> agora? Tudo o que é dele também é excluído: máquinas (o agente é desconectado), projetos, abas, chats, memória, integrações, contas de IA e tokens. As sessões dele são encerradas. Não dá para desfazer."
              values={{ email: deleting?.email ?? '' }}
              components={[<strong key="email" />]}
            />
          )
        }
        confirmLabel={t('Excluir')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.users.remove(deleting.id);
            setUsers((l) => (l ?? []).filter((x) => x.id !== deleting.id));
            void loadAccess();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t('Erro ao excluir'));
          }
          setDeleting(null);
        }}
      />
      {reviewing && (
        <Modal title={t('Revisão — {{name}}', { name: reviewing.name })} open onClose={() => setReviewing(null)}>
          <ReviewAccountPanel
            user={users?.find((x) => x.id === reviewing.id) ?? reviewing}
            onChange={(u) => {
              setUsers((l) => (l ?? []).map((x) => (x.id === u.id ? u : x)));
              setReviewing(u);
            }}
          />
        </Modal>
      )}
    </div>
    </PageFrame>
  );
}

// ── Roles ────────────────────────────────────────────────────────────────────

function RoleForm({ role, onClose, onSaved }: { role: Role | null; onClose: () => void; onSaved: (r: Role) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(role?.name ?? '');
  const [label, setLabel] = useState(role?.label ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [isAdmin, setIsAdmin] = useState(role?.is_admin ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = role
        ? await api.roles.update(role.id, { label, description: description || null, is_admin: isAdmin })
        : await api.roles.create({ name: name.toUpperCase(), label, description: description || null, is_admin: isAdmin });
      onSaved(r.role);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao salvar'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={role ? t('Editar role {{name}}', { name: role.name }) : t('Nova role')} open onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {!role && (
          <div>
            <label className="label">{t('Nome (identificador)')}</label>
            <input className="input font-mono uppercase" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} required placeholder={t('EX.: SUPPORT')} pattern="[A-Z][A-Z0-9_]*" />
          </div>
        )}
        <div>
          <label className="label">{t('Rótulo')}</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required placeholder={t('ex.: Suporte')} autoFocus />
        </div>
        <div>
          <label className="label">{t('Descrição')}</label>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {!role?.is_system && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> {t('Administrador (acesso total, ignora a matriz)')}
          </label>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            {t('Cancelar')}
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {role ? t('Salvar') : t('Criar')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RolesSection() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [deleting, setDeleting] = useState<Role | null>(null);

  const load = useCallback(() => api.roles.list().then((r) => setRoles(r.roles)).catch((err) => setError(err instanceof ApiError ? err.message : t('Erro ao carregar'))), [t]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageFrame
      title={t('Roles')}
      actions={
        can('roles', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, role: null })}>
            {t('+ role')}
          </button>
        )
      }
    >
    <div>
      <p className="mb-4 text-sm text-fg-muted">{t('Uma role é um conjunto de permissões. Roles de administrador têm acesso total; roles do sistema não podem ser excluídas.')}</p>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      <ul className="grid gap-3 md:grid-cols-2">
        {roles?.map((r) => (
          <li key={r.id} className="rounded-lg border border-line bg-bg-2 p-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-fg-dim">{r.name}</span>
              {r.is_admin && <span className="rounded bg-accent/15 px-1.5 text-[10px] uppercase text-accent">{t('admin')}</span>}
              {r.is_system && <span className="rounded bg-bg-4 px-1.5 text-[10px] uppercase text-fg-dim">{t('sistema')}</span>}
              <span className="ml-auto flex gap-0.5">
                {can('roles', 'update') && (
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" title={t('Editar')} onClick={() => setForm({ open: true, role: r })}>
                    ✎
                  </button>
                )}
                {can('roles', 'delete') && !r.is_system && (
                  <button className="rounded px-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-danger" title={t('Excluir')} onClick={() => setDeleting(r)}>
                    ✕
                  </button>
                )}
              </span>
            </div>
            <p className="mt-1 font-medium">{r.label}</p>
            {r.description && <p className="mt-0.5 text-sm text-fg-muted">{r.description}</p>}
            <p className="mt-2 text-xs text-fg-dim">
              {t('{{count}} usuários', { count: r.users ?? 0 })}
              {!r.is_admin && (
                <>
                  {' · '}
                  <NavLink to={`/settings/permissions?role=${r.id}`} className="text-accent hover:underline">
                    {t('permissões →')}
                  </NavLink>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
      {form.open && (
        <RoleForm
          key={form.role?.id ?? 'new'}
          role={form.role}
          onClose={() => setForm({ open: false, role: null })}
          onSaved={() => {
            setForm({ open: false, role: null });
            void load();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('Excluir role')}
        message={
          <Trans
            i18nKey="Excluir a role <0>{{label}}</0>? Só é possível se nenhum usuário a estiver usando."
            values={{ label: deleting?.label ?? '' }}
            components={[<strong key="label" />]}
          />
        }
        confirmLabel={t('Excluir')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.roles.remove(deleting.id);
            void load();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : t('Erro ao excluir'));
          }
          setDeleting(null);
        }}
      />
    </div>
    </PageFrame>
  );
}

// ── Permissions matrix ───────────────────────────────────────────────────────

function PermissionsSection() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [roleId, setRoleId] = useState<string>(() => new URLSearchParams(window.location.search).get('role') ?? '');
  const [matrix, setMatrix] = useState<ResourcePermissions[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    api.roles
      .list()
      .then((r) => {
        const editable = r.roles.filter((x) => !x.is_admin);
        setRoles(editable);
        setRoleId((cur) => (cur && editable.some((x) => x.id === cur) ? cur : (editable[0]?.id ?? '')));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t('Erro ao carregar')));
  }, [t]);

  useEffect(() => {
    if (!roleId) return;
    setMatrix(null);
    api.roles
      .permissions(roleId)
      .then((r) => setMatrix(r.permissions))
      .catch((err) => setError(err instanceof ApiError ? err.message : t('Erro ao carregar')));
  }, [roleId, t]);

  const toggle = async (resource: string, action: PermissionAction) => {
    const key = `${resource}:${action}`;
    setToggling(key);
    try {
      const r = await api.roles.toggle(roleId, resource, action);
      setMatrix((m) => (m ?? []).map((row) => (row.resource === resource ? { ...row, [action]: r.granted } : row)));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao alterar'));
    } finally {
      setToggling(null);
    }
  };

  const editable = can('roles', 'update');
  const role = roles.find((r) => r.id === roleId);

  return (
    <div>
      <div className="mb-4 flex items-end gap-4">
        <p className="text-sm text-fg-muted">{t('O que cada role pode fazer em cada recurso. Roles de administrador não aparecem aqui: têm acesso total.')}</p>
        <select className="input ml-auto w-auto py-1 text-sm" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} ({r.name})
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mb-3 text-sm text-danger">{error}</p>}
      {role?.description && <p className="mb-3 text-xs text-fg-dim">{role.description}</p>}
      {matrix && (
        <div className="overflow-x-auto rounded-lg border border-line bg-bg-2">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-4 py-2 text-left">{t('Recurso')}</th>
                {ACTIONS.map((a) => (
                  <th key={a} className="px-4 py-2 text-center">
                    {t(ACTION_LABELS[a])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.resource} className="border-b border-line last:border-0 hover:bg-bg-3">
                  <td className="px-4 py-2">
                    <span className="font-medium">{row.label}</span> <span className="font-mono text-[11px] text-fg-dim">{row.resource}</span>
                  </td>
                  {ACTIONS.map((a) => {
                    const key = `${row.resource}:${a}`;
                    return (
                      <td key={a} className="px-4 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[#4f8cff]"
                          checked={row[a]}
                          disabled={!editable || toggling === key}
                          onChange={() => void toggle(row.resource, a)}
                          aria-label={`${row.label}: ${t(ACTION_LABELS[a])}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
