import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { deletionDate, saveDeletionNotice } from '../lib/account-deletion';
import { useAuth } from '../lib/auth';
import { Modal } from './Modal';

type Method = 'password' | 'code';

/**
 * Perfil → Excluir minha conta (TER-720). Says what goes and what stays, asks the person to prove it is
 * them again (password, or a code e-mailed to the account), then deactivates the account. The server
 * ends every session on success, so the dialog ends on a confirmation that leads to the login page.
 */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [method, setMethod] = useState<Method>(user?.has_password ? 'password' : 'code');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeTtl, setCodeTtl] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível continuar.');
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (m: Method) => {
    setMethod(m);
    setError(null);
  };

  const sendCode = () =>
    void run(async () => {
      const r = await api.account.sendDeletionCode();
      setCodeTtl(r.ttl_minutes);
      setCode('');
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.account.requestDeletion(method === 'password' ? { password } : { code });
      if (r.scheduled_at) saveDeletionNotice(r.scheduled_at);
      setScheduledAt(r.scheduled_at ?? '');
    });
  };

  // The session is gone by now: leaving through logout() clears what the app still holds.
  const toLogin = () => void logout().then(() => navigate('/login'));

  if (scheduledAt !== null) {
    return (
      <Modal title="Conta desativada" open={open} onClose={toLogin} width="max-w-lg" dismissible={false}>
        <div className="space-y-3 text-sm text-fg-muted">
          <p>
            Sua conta foi desativada{scheduledAt && <> e será excluída em <strong className="text-fg">{deletionDate(scheduledAt)}</strong></>}. Enviamos
            uma confirmação para o seu e-mail.
          </p>
          <p>Mudou de ideia? Entre de novo antes dessa data e cancele a exclusão.</p>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-primary" onClick={toLogin} autoFocus>
            Ir para o login
          </button>
        </div>
      </Modal>
    );
  }

  const ready = method === 'password' ? password.length > 0 : code.length === 6;
  return (
    <Modal title="Excluir minha conta" open={open} onClose={onClose} width="max-w-lg" dismissible={!busy}>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <div className="space-y-2 text-fg-muted">
          <p>
            Sua conta é desativada na hora e excluída para sempre <strong className="text-fg">30 dias</strong> depois. Até lá, basta entrar de novo
            para cancelar a exclusão.
          </p>
          <p className="font-medium text-fg">O que é excluído</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>máquinas (o agente é desconectado), projetos com cards, notas, tickets e setups, e abas</li>
            <li>chat (conversas, mensagens e anexos) e memória</li>
            <li>integrações, contas de IA, tokens de API e dispositivos</li>
            <li>notificações e todas as sessões abertas</li>
          </ul>
          <p className="font-medium text-fg">O que é mantido</p>
          <p>Por obrigação legal, os registros de acesso ficam guardados por 6 meses (Marco Civil da Internet), e dados fiscais, quando houver.</p>
        </div>

        {method === 'password' ? (
          <div>
            <label className="label" htmlFor="delete-account-password">
              Sua senha
            </label>
            <input
              id="delete-account-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button type="button" className="mt-1 text-xs text-fg-dim hover:text-fg" onClick={() => switchTo('code')}>
              Receber código por e-mail
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-fg-muted">
              Para confirmar que é você, enviamos um código de 6 dígitos para <strong className="text-fg">{user?.email}</strong>.
            </p>
            {codeTtl === null ? (
              <button type="button" className="btn-ghost border border-line" disabled={busy} onClick={sendCode}>
                {busy ? 'Enviando…' : 'Enviar código'}
              </button>
            ) : (
              <div>
                <label className="label" htmlFor="delete-account-code">
                  Código de 6 dígitos
                </label>
                <input
                  id="delete-account-code"
                  className="input text-center font-mono text-2xl tracking-[0.5em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                />
                <button type="button" className="mt-1 text-xs text-fg-dim hover:text-fg" disabled={busy} onClick={sendCode}>
                  reenviar código ({codeTtl} min)
                </button>
              </div>
            )}
            {user?.has_password && (
              <button type="button" className="block text-xs text-fg-dim hover:text-fg" onClick={() => switchTo('password')}>
                Usar minha senha
              </button>
            )}
          </div>
        )}

        {error && <p className="text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn-danger" disabled={busy || !ready}>
            {busy ? 'Excluindo…' : 'Excluir minha conta'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
