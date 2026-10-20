import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatSimilarity } from '../lib/format';
import type { AutoThresholdPair, AutoThresholds, ChatMemory } from '../lib/types';
import { Trans, useTranslation } from '../i18n';

/** The range the server accepts for a pinned threshold (`autoThresholdsBody`, packages/mobile-api). */
export const AUTO_THRESHOLD_MIN = 0.5;
export const AUTO_THRESHOLD_MAX = 1;
/** The countdown of a suggested answer when the server does not say (`auto_delay_seconds`). */
const DEFAULT_DELAY_SECONDS = 60;

const fieldValue = (n: number) => n.toFixed(2);
/** What a field holds as a number; a comma is accepted where the browser lets one through. */
const parseField = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw.trim().replace(',', '.')));

/** Why the two fields cannot be pinned as they are, or null when they can. */
export function thresholdsProblem(high: number, low: number): 'range' | 'order' | null {
  const inRange = (n: number) => Number.isFinite(n) && n >= AUTO_THRESHOLD_MIN && n <= AUTO_THRESHOLD_MAX;
  if (!inRange(high) || !inRange(low)) return 'range';
  return low > high ? 'order' : null;
}

/**
 * "Resposta automática" in "Permissões do chat" (TER-642): the similarity thresholds that decide whether
 * an answer from memory is sent at once, suggested with a countdown, or not offered — where they come
 * from (pinned by hand, calibrated from the person's own answers, or the defaults) and a form to pin
 * them, which turns calibration off until "Voltar ao ajuste automático". Renders nothing when the
 * server has no memory (`available: false`), predates the thresholds, or the read failed: the grants
 * around it never depend on it. A failed save goes to `onError`, shown with the view's other errors.
 */
export function ChatAutoThresholds({ onError }: { onError: (message: string | null) => void }) {
  const { t } = useTranslation();
  const [memory, setMemory] = useState<ChatMemory | null>(null);
  const [high, setHigh] = useState('');
  const [low, setLow] = useState('');
  const [saving, setSaving] = useState(false);
  const problemId = useId();

  const apply = (m: ChatMemory) => {
    setMemory(m);
    if (m.auto_thresholds) {
      setHigh(fieldValue(m.auto_thresholds.high));
      setLow(fieldValue(m.auto_thresholds.low));
    }
  };

  useEffect(() => {
    let alive = true;
    api.chatMemory().then(
      (m) => alive && apply(m),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  const thresholds = memory?.auto_thresholds;
  if (!memory?.available || !thresholds) return null;

  const problem = thresholdsProblem(parseField(high), parseField(low));
  const save = async (body: AutoThresholdPair | null) => {
    setSaving(true);
    onError(null);
    try {
      apply(await api.setChatMemory({ auto_thresholds: body }));
    } catch (e) {
      onError(e instanceof ApiError ? e.message : t('Não foi possível salvar a alteração.'));
    } finally {
      setSaving(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || saving) return;
    void save({ high: parseField(high), low: parseField(low) });
  };

  const shown = { high: formatSimilarity(thresholds.high), low: formatSimilarity(thresholds.low) };
  const numberProps = { type: 'number', inputMode: 'decimal', min: AUTO_THRESHOLD_MIN, max: AUTO_THRESHOLD_MAX, step: 0.01, disabled: saving, 'aria-invalid': problem !== null, 'aria-describedby': problem ? problemId : undefined } as const;
  return (
    <section aria-labelledby="chat-auto-thresholds" className="space-y-2">
      <h2 id="chat-auto-thresholds" className="text-sm font-semibold text-fg">
        {t('Resposta automática')}
      </h2>
      <p className="text-xs text-fg-dim">{t('Quando uma aba faz uma pergunta parecida com uma que a memória já tem, o chat mede a semelhança (de 0 a 1) e age conforme estes limiares.')}</p>
      <ul className="list-inside list-disc space-y-0.5 text-sm text-fg">
        <li>{t('A partir de {{high}}: envia a resposta sozinho.', shown)}</li>
        <li>{t('De {{low}} até {{high}}: sugere a resposta e envia em {{seconds}} s, contando só com o termhub em foco.', { ...shown, seconds: memory.auto_delay_seconds ?? DEFAULT_DELAY_SECONDS })}</li>
        <li>{t('Abaixo de {{low}}: não sugere nada.', shown)}</li>
      </ul>
      <p className="text-xs text-fg-dim">
        <ThresholdsSource thresholds={thresholds} />
      </p>
      <p className="text-xs text-fg-dim">
        {memory.autodecide ? (
          <Trans i18nKey="Só age com «Responder sozinho» ligado, em <0>Memória do chat</0>." components={[<Link key="m" to="/chat/memoria" className="underline hover:text-fg" />]} />
        ) : (
          <Trans i18nKey="«Responder sozinho» está desligado: nenhuma resposta é enviada sozinha. Ligue em <0>Memória do chat</0>." components={[<Link key="m" to="/chat/memoria" className="underline hover:text-fg" />]} />
        )}
      </p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={submit} noValidate>
        <label className="block text-xs text-fg-dim">
          {t('Limiar de envio')}
          <input {...numberProps} className="input mt-1 w-28" value={high} onChange={(e) => setHigh(e.target.value)} />
        </label>
        <label className="block text-xs text-fg-dim">
          {t('Limiar de sugestão')}
          <input {...numberProps} className="input mt-1 w-28" value={low} onChange={(e) => setLow(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary" disabled={saving || problem !== null}>
          {t('Fixar limiares')}
        </button>
        {thresholds.source === 'manual' && (
          <button type="button" className="btn-ghost" disabled={saving} onClick={() => void save(null)}>
            {t('Voltar ao ajuste automático')}
          </button>
        )}
      </form>
      {problem && (
        <p id={problemId} className="text-xs text-danger">
          {problem === 'range'
            ? t('Use valores entre {{min}} e {{max}}.', { min: formatSimilarity(AUTO_THRESHOLD_MIN), max: formatSimilarity(AUTO_THRESHOLD_MAX) })
            : t('O limiar de sugestão não pode passar do limiar de envio.')}
        </p>
      )}
    </section>
  );
}

/** Where the thresholds in force come from. A source a newer server adds says nothing here. */
function ThresholdsSource({ thresholds }: { thresholds: AutoThresholds }) {
  const { t } = useTranslation();
  switch (thresholds.source) {
    case 'manual':
      return <>{t('Limiares fixados por você: o ajuste automático está desligado.')}</>;
    case 'calibrated':
      return <>{t('Limiares ajustados pelo seu histórico ({{count}} respostas).', { count: thresholds.samples })}</>;
    case 'default':
      return <>{t('Limiares padrão — o ajuste automático começa com {{min}} respostas suas ({{samples}} até agora).', { min: thresholds.min_samples, samples: thresholds.samples })}</>;
    default:
      return null;
  }
}
