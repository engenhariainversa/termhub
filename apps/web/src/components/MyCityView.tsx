import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useCityLink, type CityLinkState } from '../lib/city-link';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { cityLinkFor, displayLink } from '../lib/public-city';
import type { Project } from '../lib/types';
import { NicknameDialog } from './NicknameDialog';
import { PublishControl } from './PublishControl';
import { i18n, Trans, useTranslation } from '../i18n';

type CopyStatus = 'idle' | 'copied' | 'failed';

/**
 * Settings → Minha cidade: the signed-in user's own public city, for every account (no resource
 * grant). The nickname (set once, never changed), the city's address, and the projects this user
 * owns with the same publish switch as the project page. A published project is a building on the
 * street (city-by-project §2.4) unless it is archived, and its robots there are its tabs on the
 * machines this person owns. The app only knows the open terminals live (not the simulator tabs the
 * street also draws), so each row says whether it is published and how many of those terminals it
 * has now — terminals, not agents, so it never claims a count it cannot see.
 */
export function MyCityView() {
  const { t } = useTranslation();
  const { user, publicCityUrl, can } = useAuth();
  const { projects, machines, hiddenLocal, loading } = useData();
  const { openTabs } = useMonitor();
  const [choosingNickname, setChoosingNickname] = useState(false);

  const nickname = user?.nickname ?? null;
  const link = cityLinkFor(publicCityUrl, nickname);
  const short = useCityLink(!!nickname);
  // An account that cannot list projects cannot own any either; its project list never loads, so
  // there is nothing to wait for.
  const canListProjects = can('projects', 'read');

  // Hidden local machines (someone's own computer added from another browser) are still the
  // person's, so their terminals count here too.
  const ownMachines = useMemo(() => new Set([...machines, ...hiddenLocal].filter((m) => user && m.owner_id === user.id).map((m) => m.id)), [machines, hiddenLocal, user]);
  /** the project's open terminals on the machines this person owns: what of it the street shows that the app can count */
  const terminalsOf = (p: Project) => openTabs.filter((tab) => tab.project_id === p.id && ownMachines.has(tab.machine_id)).length;

  const mine = canListProjects && user ? projects.filter((p) => p.owner_id === user.id) : [];
  const onStreet = mine.some((p) => p.is_public && p.status !== 'archived');

  return (
    <div className="space-y-6">
      <p className="text-sm text-fg-muted">{t('Sua cidade pública mostra, para quem tiver o link, cada projeto que você publicar e os agentes dele que rodam nas suas máquinas.')}</p>

      <section className="rounded-lg border border-line bg-bg-2 p-4">
        <h2 className="text-sm font-semibold">{t('Apelido')}</h2>
        {nickname ? (
          <>
            <p className="mt-2 font-mono text-sm">{nickname}</p>
            <p className="mt-1 text-xs text-fg-dim">{t('O apelido não pode ser trocado: os links que você já compartilhou dependem dele.')}</p>
          </>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <p className="text-sm text-fg-muted">{t('Você ainda não escolheu um apelido. Ele vira o endereço da sua cidade e não pode ser trocado depois.')}</p>
            <button type="button" className="btn-primary ml-auto shrink-0 text-xs" onClick={() => setChoosingNickname(true)}>
              {t('Escolher apelido')}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-line bg-bg-2 p-4">
        <h2 className="text-sm font-semibold">{t('Link da cidade')}</h2>
        {link ? (
          <>
            <CityLink url={link} />
            <a href={link} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
              {t('Abrir minha cidade para compartilhar')}
            </a>
            <p className="text-xs text-fg-dim">{t('Imagens para story e post e um vídeo de 10 s com som saem da própria página da cidade, no botão Compartilhar.')}</p>
            {!onStreet && <p className="mt-2 text-xs text-warn">{t('Nenhum projeto publicado ainda: quem abrir o link encontra a cidade vazia. Publique um projeto abaixo.')}</p>}
          </>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">
            {nickname ? t('O endereço da cidade pública ainda não foi carregado.') : t('Escolha um apelido para ter o endereço da sua cidade pública.')}
          </p>
        )}
      </section>

      <ShortLinkSection state={short} />

      <section>
        <h2 className="mb-2 text-sm font-semibold">{t('Seus projetos')}</h2>
        {canListProjects && loading ? (
          <p className="text-sm text-fg-dim">{t('Carregando…')}</p>
        ) : mine.length === 0 ? (
          <p className="rounded-lg border border-line bg-bg-2 p-4 text-sm text-fg-muted">{t('Você ainda não tem projetos. Os projetos que você criar aparecem aqui para publicar na sua cidade.')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-bg-2">
            {mine.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{p.name}</span>
                    <span className="font-mono text-xs text-fg-dim">{p.key}</span>
                  </div>
                  <p className="truncate text-xs text-fg-dim">{rowLine(p, terminalsOf(p))}</p>
                </div>
                <Link to={`/projects/${p.id}`} className="shrink-0 text-xs text-accent hover:underline" aria-label={t('Abrir projeto {{name}}', { name: p.name })}>
                  {t('abrir →')}
                </Link>
                <PublishControl project={p} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <NicknameDialog open={choosingNickname} onClose={() => setChoosingNickname(false)} />
    </div>
  );
}

/**
 * What a row says about the street. A published project always has its building there, even with
 * nobody in it right now — unless it is archived, which the street never shows, whatever its switch.
 */
function rowLine(p: Project, terminals: number): string {
  if (p.status === 'archived') return i18n.t('arquivado (não aparece na cidade)');
  if (!p.is_public) return i18n.t('não publicado');
  return i18n.t('publicado · {{count}} terminais agora', { count: terminals });
}

/** Copy-to-clipboard with the button's own feedback, shared by the city link and the short link. */
function useCopy(): [CopyStatus, (text: string) => Promise<void>] {
  const [status, setStatus] = useState<CopyStatus>('idle');
  useEffect(() => {
    if (status === 'idle') return;
    const id = setTimeout(() => setStatus('idle'), 2500);
    return () => clearTimeout(id);
  }, [status]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  };
  return [status, copy];
}

const copyLabel = (status: CopyStatus) => (status === 'copied' ? i18n.t('Copiado') : status === 'failed' ? i18n.t('Não foi possível copiar') : i18n.t('Copiar'));

function CityLink({ url }: { url: string }) {
  const { t } = useTranslation();
  const [status, copy] = useCopy();
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-bg-3 px-2 py-1 font-mono text-xs">{url}</code>
      <button type="button" className="btn-ghost text-xs" onClick={() => void copy(url)}>
        {copyLabel(status)}
      </button>
      <a href={url} target="_blank" rel="noopener noreferrer" className="btn-ghost text-xs">
        {t('Abrir')}
      </a>
    </div>
  );
}

/**
 * The city's short link (spec 2026-09-23 §3.5): the partner one TypeToAccess created, or one the
 * person pasted. Hidden when the instance has no short links and none is stored, and before the
 * person has a nickname (no city to link to).
 */
function ShortLinkSection({ state }: { state: CityLinkState }) {
  const { t } = useTranslation();
  const { link, saving, error, setCustom, restorePartner, clearError } = state;
  const [status, copy] = useCopy();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!link?.city_url || (!link.enabled && !link.short_url)) return null;

  const openForm = () => {
    clearError();
    setDraft('');
    setEditing(true);
  };
  const cancel = () => {
    clearError();
    setDraft('');
    setEditing(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await setCustom(draft.trim())) {
      setEditing(false);
      setDraft('');
    }
  };

  return (
    <section aria-label={t('Link curto')} className="rounded-lg border border-line bg-bg-2 p-4">
      <h2 className="text-sm font-semibold">{t('Link curto')}</h2>
      {link.short_url ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('Link curto: {{link}}', { link: displayLink(link.short_url) })}</span>
            <button type="button" className="btn-ghost text-xs" onClick={() => void copy(link.short_url!)}>
              {copyLabel(status)}
            </button>
          </div>
          {link.source === 'partner' && <p className="mt-1 text-xs text-fg-dim">{t('Criado pelo TypeToAccess, parceiro do termhub')}</p>}
          {/* only when there is a partner link to go back to (the server refuses safely otherwise) */}
          {link.source === 'custom' && link.enabled && link.partner_url && (
            <button type="button" className="btn-ghost mt-2 text-xs" disabled={saving} onClick={() => void restorePartner()}>
              {t('Voltar ao link da parceria')}
            </button>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">{t('O link curto ainda não foi criado. Enquanto isso, use o link da cidade acima.')}</p>
      )}
      {link.enabled &&
        (editing ? (
          <form className="mt-3 space-y-2" onSubmit={(e) => void save(e)}>
            <p className="text-xs text-fg-muted">
              <Trans
                i18nKey="Crie um link em <0>typetoaccess.it</0> que leve para {{url}} e cole aqui."
                values={{ url: link.city_url }}
                components={[<a key="t" href="https://typetoaccess.it" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline" />]}
              />
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={t('Seu link curto')}
                className="input min-w-0 flex-1 text-sm"
                placeholder="https://77a.it/…" /* i18n-ignore */
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button type="submit" className="btn-primary text-xs" disabled={saving || !draft.trim()}>
                {t('Salvar')}
              </button>
              <button type="button" className="btn-ghost text-xs" onClick={cancel}>
                {t('Cancelar')}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn-ghost mt-2 text-xs" onClick={openForm}>
            {t('Usar meu próprio link curto')}
          </button>
        ))}
      {/* outside the form: a failed restore ("Voltar ao link da parceria") is reported here too */}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
