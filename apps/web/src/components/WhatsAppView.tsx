import { useEffect, useState, type FormEvent } from 'react';
import { tk, useTranslation } from '../i18n';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { WhatsAppProbe, WhatsAppSettings } from '../lib/types';
import { ConfirmDialog } from './Modal';

/** What each error code of the server means, for the person. */
const PROBE_ERRORS: Record<string, string> = {
  AUTH: tk('O servidor recusou a API key.'),
  INSTANCE_NOT_FOUND: tk('Essa instância não existe no servidor.'),
  NOT_CONNECTED: tk('A instância existe, mas o WhatsApp não está conectado: leia o QR code no manager do Evolution.'),
  UNREACHABLE: tk('Não consegui falar com o servidor.'),
  TIMEOUT: tk('O servidor demorou demais para responder.'),
  REDIRECT: tk('O servidor respondeu com um redirecionamento: use o endereço final da API.'),
  BAD_NUMBER: tk('O servidor recusou o número: confira se ele tem WhatsApp.'),
};

const probeText = (r: WhatsAppProbe): string | null => (r.ok ? null : (r.reason ?? PROBE_ERRORS[r.code] ?? r.code));

const LEVELS: { key: 'notify_needs_you' | 'notify_done'; label: string; hint: string }[] = [
  { key: 'notify_needs_you', label: tk('Precisa de você'), hint: tk('Uma pergunta, uma aprovação ou um erro que bloqueia.') },
  { key: 'notify_done', label: tk('Concluído'), hint: tk('Aconteceu o que você pediu para acompanhar: build pronto, PR mesclado, versão publicada.') },
];

interface Form {
  server_url: string;
  api_key: string;
  instance: string;
  number: string;
  enabled: boolean;
  notify_needs_you: boolean;
  notify_done: boolean;
}

const formOf = (s: WhatsAppSettings): Form => ({
  server_url: s.server_url ?? '',
  api_key: '',
  instance: s.instance ?? '',
  number: s.number ?? '',
  enabled: s.configured ? s.enabled : true,
  notify_needs_you: s.notify_needs_you,
  notify_done: s.notify_done,
});

/**
 * Configurações → WhatsApp (TER-1201): the person's own Evolution API server. The concierge's notices
 * that reach the phone (Configurações → Avisos: levels, quiet hours, grouping) also go to this number,
 * for the levels ticked here. The API key is write-only: once saved, the field stays empty and blank
 * keeps it.
 */
export function WhatsAppView() {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<WhatsAppSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'message' | 'remove'>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    api.whatsapp
      .get()
      .then((r) => {
        setSaved(r.whatsapp);
        setForm(formOf(r.whatsapp));
      })
      .catch(() => setNotice({ ok: false, text: t('Não foi possível carregar o WhatsApp.') }));
  }, [t]);

  if (!form || !saved) return <p className="text-sm text-fg-muted">{notice?.text ?? t('Carregando…')}</p>;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const fail = (err: unknown, fallback: string) => setNotice({ ok: false, text: err instanceof ApiError ? err.message : fallback });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setNotice(null);
    try {
      const { api_key, ...rest } = form;
      const r = await api.whatsapp.save({ ...rest, ...(api_key.trim() ? { api_key: api_key.trim() } : {}) });
      setSaved(r.whatsapp);
      setForm(formOf(r.whatsapp));
      setNotice({ ok: true, text: t('Salvo.') });
    } catch (err) {
      fail(err, t('Não foi possível salvar. Tente de novo.'));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setNotice(null);
    try {
      const r = await api.whatsapp.test({ server_url: form.server_url.trim() || undefined, instance: form.instance.trim() || undefined, api_key: form.api_key.trim() || undefined });
      setNotice(r.ok ? { ok: true, text: t('Conectado: a instância está pronta para enviar.') } : { ok: false, text: t(probeText(r) ?? '') });
    } catch (err) {
      fail(err, t('Não foi possível testar a conexão.'));
    } finally {
      setBusy(null);
    }
  };

  const message = async () => {
    setBusy('message');
    setNotice(null);
    try {
      const r = await api.whatsapp.testMessage();
      setNotice(r.ok ? { ok: true, text: t('Mensagem de teste enviada para o seu número.') } : { ok: false, text: t(probeText(r) ?? '') });
      setSaved(await api.whatsapp.get().then((x) => x.whatsapp));
    } catch (err) {
      fail(err, t('Não foi possível enviar a mensagem de teste.'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setConfirmRemove(false);
    setBusy('remove');
    setNotice(null);
    try {
      await api.whatsapp.remove();
      const r = await api.whatsapp.get();
      setSaved(r.whatsapp);
      setForm(formOf(r.whatsapp));
      setNotice({ ok: true, text: t('WhatsApp removido.') });
    } catch (err) {
      fail(err, t('Não foi possível remover.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-sm text-fg-muted">
        {t('Ligue o seu servidor Evolution API para receber no WhatsApp os avisos do concierge que chegam no celular. As regras de Avisos (níveis, horário de silêncio e agrupamento) valem aqui também. A API key fica guardada criptografada e nunca é mostrada de novo.')}
      </p>
      <section aria-label={t('Servidor')} className="grid gap-3 rounded-lg border border-line bg-bg-2 p-4 md:grid-cols-2">
        <div>
          <label className="label" htmlFor="wa-url">
            {t('Endereço do servidor')}
          </label>
          {/* i18n-ignore: an example URL */}
          <input id="wa-url" className="input" type="url" required value={form.server_url} onChange={(e) => set({ server_url: e.target.value })} placeholder="https://evolution.example.com" />
          <p className="mt-1 text-xs text-fg-muted">{t('Endereço público com https (o termhub não acessa redes internas).')}</p>
        </div>
        <div>
          <label className="label" htmlFor="wa-key">
            {t('API key')}
          </label>
          <input
            id="wa-key"
            className="input"
            type="password"
            autoComplete="off"
            required={!saved.has_api_key}
            value={form.api_key}
            onChange={(e) => set({ api_key: e.target.value })}
            placeholder={saved.has_api_key ? t('Salva: deixe em branco para manter') : t('A apikey global ou a da instância')}
          />
        </div>
        <div>
          <label className="label" htmlFor="wa-instance">
            {t('Instância')}
          </label>
          <input id="wa-instance" className="input" required value={form.instance} onChange={(e) => set({ instance: e.target.value })} placeholder={t('Nome da instância no Evolution')} />
        </div>
        <div>
          <label className="label" htmlFor="wa-number">
            {t('Seu número')}
          </label>
          {/* i18n-ignore: an example phone number */}
          <input id="wa-number" className="input" inputMode="tel" required value={form.number} onChange={(e) => set({ number: e.target.value })} placeholder="5562999998888" />
          <p className="mt-1 text-xs text-fg-muted">{t('Com o código do país e o DDD. As mensagens só vão para este número.')}</p>
        </div>
      </section>
      <section aria-label={t('O que vai pelo WhatsApp')} className="space-y-3 rounded-lg border border-line bg-bg-2 p-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span className="text-sm font-medium">{t('Enviar avisos pelo WhatsApp')}</span>
        </label>
        {LEVELS.map((l) => (
          <label key={l.key} className="flex items-start gap-3 pl-6">
            <input type="checkbox" className="mt-1" disabled={!form.enabled} checked={form[l.key]} onChange={(e) => set({ [l.key]: e.target.checked })} />
            <span>
              <span className="block text-sm font-medium">{t(l.label)}</span>
              <span className="block text-xs text-fg-muted">{t(l.hint)}</span>
            </span>
          </label>
        ))}
      </section>
      {saved.configured && (
        <p className="text-xs text-fg-muted">
          {saved.last_error && saved.last_error_at
            ? t('Último envio falhou em {{when}}: {{reason}}', { when: formatDateTime(saved.last_error_at), reason: t(PROBE_ERRORS[saved.last_error] ?? saved.last_error) })
            : saved.last_sent_at
              ? t('Último envio: {{when}}', { when: formatDateTime(saved.last_sent_at) })
              : t('Nenhuma mensagem enviada ainda.')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy !== null}>
          {busy === 'save' ? t('Salvando…') : t('Salvar')}
        </button>
        <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void test()}>
          {busy === 'test' ? t('Testando…') : t('Testar conexão')}
        </button>
        {saved.configured && (
          <>
            <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void message()}>
              {busy === 'message' ? t('Enviando…') : t('Enviar mensagem de teste')}
            </button>
            <button type="button" className="btn-danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
              {t('Remover')}
            </button>
          </>
        )}
      </div>
      {notice && (
        <p role={notice.ok ? 'status' : 'alert'} className={notice.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
          {notice.text}
        </p>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={t('Remover o WhatsApp?')}
        message={t('A configuração e a API key são apagadas e os avisos deixam de ir para o WhatsApp.')}
        confirmLabel={t('Remover')}
        danger
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </form>
  );
}
