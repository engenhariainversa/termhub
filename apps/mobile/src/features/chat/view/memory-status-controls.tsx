import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { TMemoryReplacement, TMemoryStatus } from '@/services/api/contract';
import { AppText, Button, Field } from '@/ui';
import { t, tk, useTranslation } from '@/i18n';
import { formatDate } from '@/i18n/format';
import { useChatMemoryStore } from '../viewmodel/useChatMemoryStore';

/** The status line's label (TER-1013) — the mobile twin of the web's `MemoryStatusControls`. */
const STATUS_LABEL: Record<TMemoryStatus, string> = {
  current: tk('Vigente'),
  outdated: tk('Desatualizada'),
  wrong: tk('Errada'),
  superseded: tk('Substituída'),
};

const STATUS_CLASS: Record<TMemoryStatus, string> = {
  current: 'text-app-ok',
  outdated: 'text-app-muted',
  wrong: 'text-app-danger',
  superseded: 'text-app-muted',
};

export function memoryStatusText(status: TMemoryStatus, supersededBy: { title: string } | null): string {
  if (status === 'superseded' && supersededBy) return t('Substituída por «{{title}}»', { title: supersededBy.title });
  return t(STATUS_LABEL[status]);
}

export function MemoryStatusLine({ status, supersededBy }: { status: TMemoryStatus; supersededBy: { title: string } | null }) {
  return (
    <AppText variant="muted" className={`text-xs ${STATUS_CLASS[status]}`} testID="memory-status">
      {memoryStatusText(status, supersededBy)}
    </AppText>
  );
}

/**
 * "Desatualizada", "Errada" and "Substituída por…" on one decision or concierge note (TER-1013), and
 * "Desfazer" once it carries any of them. "Substituída por…" opens an inline picker of the person's
 * other current decisions and notes, searched as they type.
 */
export function MemoryStatusControls({ kind, id, status }: { kind: 'decision' | 'note'; id: string; status: TMemoryStatus }) {
  const { t } = useTranslation();
  const ref = `${kind}:${id}`;
  const busy = useChatMemoryStore((s) => s.statusBusyRef !== null);
  const setStatus = useChatMemoryStore((s) => s.setStatus);
  const searchReplacements = useChatMemoryStore((s) => s.searchReplacements);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<TMemoryReplacement[] | null>(null);
  const gen = useRef(0);

  // The picker's own search, debounced; a slower, older answer never replaces a newer one.
  useEffect(() => {
    if (!picking) return;
    const myGen = ++gen.current;
    const timer = setTimeout(() => {
      void searchReplacements(q, ref).then((items) => {
        if (gen.current === myGen) setOptions(items ?? []);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [picking, q, ref, searchReplacements]);
  useEffect(
    () => () => {
      gen.current += 1;
    },
    [],
  );

  if (status !== 'current') {
    return (
      <View className="flex-row flex-wrap items-center gap-3">
        <Button label={t('Desfazer')} variant="ghost" disabled={busy} onPress={() => void setStatus(kind, id, 'current')} />
      </View>
    );
  }

  return (
    <View className="gap-2">
      <View className="flex-row flex-wrap items-center gap-3">
        <Button label={t('Desatualizada')} variant="ghost" disabled={busy} onPress={() => void setStatus(kind, id, 'outdated')} />
        <Button label={t('Errada')} variant="ghost" disabled={busy} onPress={() => void setStatus(kind, id, 'wrong')} />
        <Button
          label={t('Substituída por…')}
          variant="ghost"
          disabled={busy}
          onPress={() => {
            setPicking((p) => !p);
            setOptions(null);
            setQ('');
          }}
        />
      </View>
      {picking ? (
        <View className="gap-2 rounded-xl border border-app-border p-3">
          <Field label={t('Qual item substitui este?')} value={q} onChangeText={setQ} placeholder={t('Buscar decisões e anotações')} testID={`memory-replacement-${ref}`} />
          {options === null ? (
            <AppText variant="muted">{t('Carregando…')}</AppText>
          ) : options.length === 0 ? (
            <AppText variant="muted">{t('Nenhum item vigente encontrado.')}</AppText>
          ) : (
            options.map((o) => (
              <Pressable
                key={o.ref}
                accessibilityRole="button"
                accessibilityLabel={o.title}
                disabled={busy}
                onPress={() => {
                  void setStatus(kind, id, 'superseded', o.ref).then((ok) => {
                    if (ok) setPicking(false);
                  });
                }}
                className="gap-0.5 rounded-lg px-2 py-2 active:bg-app-surface2"
              >
                <AppText>{o.title}</AppText>
                <AppText variant="muted" className="text-xs">
                  {`${o.kind === 'decision' ? t('Decisão') : t('Anotação')} · → ${o.detail} · ${o.project_name ?? t('sem projeto')} · ${formatDate(o.created_at)}`}
                </AppText>
              </Pressable>
            ))
          )}
          <Button label={t('Cancelar')} variant="ghost" onPress={() => setPicking(false)} />
        </View>
      ) : null}
    </View>
  );
}
