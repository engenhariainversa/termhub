import { useState, type ReactNode } from 'react';
import { AUTONOMY_LABEL, autonomyConfirmText, needsAutonomyConfirm } from '../lib/automation';
import type { AutomationAutonomy, ProjectAutomation } from '../lib/types';
import { ConfirmDialog } from './Modal';

const TYPE_OPTIONS: { type: ProjectAutomation['types'][number]; label: string }[] = [
  { type: 'story', label: 'Story' },
  { type: 'task', label: 'Tarefa' },
  { type: 'bug', label: 'Bug' },
  { type: 'spike', label: 'Spike' },
];

const LEVELS = Object.keys(AUTONOMY_LABEL) as AutomationAutonomy[];

interface Props {
  value: ProjectAutomation;
  onChange: (next: ProjectAutomation) => void;
}

/** The "Trabalho automático" block of the project Setup: a controlled part of `SetupForm`. */
export function AutomationSetup({ value, onChange }: Props) {
  const [pending, setPending] = useState<ProjectAutomation | null>(null);

  /** Turning it on, or raising the level to Deploy or Publicação, waits for a confirmation. */
  const propose = (next: ProjectAutomation) => {
    if (needsAutonomyConfirm(value, next)) setPending(next);
    else onChange(next);
  };
  const set = <K extends keyof ProjectAutomation>(key: K, v: ProjectAutomation[K]) => onChange({ ...value, [key]: v });
  const toggleType = (type: ProjectAutomation['types'][number]) => {
    const has = value.types.includes(type);
    if (has && value.types.length === 1) return; // at least one type
    set('types', TYPE_OPTIONS.map((o) => o.type).filter((t) => (t === type ? !has : value.types.includes(t))));
  };

  return (
    <section className="rounded-lg border border-line bg-bg-2 p-4">
      <h3 className="text-sm font-semibold">Trabalho automático</h3>
      <p className="mb-3 text-xs text-fg-dim">Os agentes pegam sozinhos os cards marcados como automáticos. Desligado por padrão.</p>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-accent" checked={value.enabled} onChange={(e) => propose({ ...value, enabled: e.target.checked })} />
          Ligar trabalho automático neste projeto
        </label>

        <Field label="Tipos de card">
          <div className="flex flex-wrap gap-4">
            {TYPE_OPTIONS.map((o) => (
              <label key={o.type} className="flex items-center gap-2 text-sm text-fg-muted">
                <input type="checkbox" className="accent-accent" checked={value.types.includes(o.type)} onChange={() => toggleType(o.type)} />
                {o.label}
              </label>
            ))}
          </div>
        </Field>

        <Field label="Até onde os agentes vão sozinhos">
          <select className="input" value={value.autonomy} onChange={(e) => propose({ ...value, autonomy: e.target.value as AutomationAutonomy })}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {AUTONOMY_LABEL[l]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-fg-dim">Envio às lojas nunca é automático.</p>
        </Field>

        <Field label="Caminhos de release" hint="globs, um por linha; mudanças neles exigem o nível Publicação">
          <ListInput value={value.release_paths} onChange={(v) => set('release_paths', v)} placeholder="apps/mobile/app.json" />
        </Field>
        <Field label="Caminhos das lojas" hint="globs, um por linha; sempre param para você">
          <ListInput value={value.store_paths} onChange={(v) => set('store_paths', v)} placeholder="apps/mobile/ios/**" />
        </Field>
        <Field label="Workflows de release" hint="um por linha">
          <ListInput value={value.release_workflows} onChange={(v) => set('release_workflows', v)} placeholder="publish-agent.yml" />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Padrão da branch do épico" hint="use {ref}">
            <input className="input font-mono" value={value.epic_branch_pattern} onChange={(e) => set('epic_branch_pattern', e.target.value)} />
          </Field>
          <Field label="Pasta dos worktrees">
            <input className="input font-mono" value={value.worktrees_dir} onChange={(e) => set('worktrees_dir', e.target.value)} />
          </Field>
          <Field label="Máximo em paralelo">
            <NumberInput value={value.max_parallel} min={1} max={100} placeholder="Sem limite" onChange={(v) => set('max_parallel', v)} />
          </Field>
          <Field label="Orçamento diário (USD)">
            <NumberInput value={value.daily_budget_usd} min={0.01} max={100000} step="any" placeholder="Desligado" onChange={(v) => set('daily_budget_usd', v)} />
          </Field>
          <Field label="Retomadas por card">
            <NumberInput value={value.resume_max} min={0} max={10} onChange={(v) => set('resume_max', v ?? 0)} />
          </Field>
          <Field label="Tentativas de correção do CI">
            <NumberInput value={value.fix_attempts} min={0} max={10} onChange={(v) => set('fix_attempts', v ?? 0)} />
          </Field>
          <Field label="Hora do resumo diário" hint="0 a 23; vazio = sem resumo">
            <NumberInput value={value.summary_hour} min={0} max={23} placeholder="Sem resumo" onChange={(v) => set('summary_hour', v)} />
          </Field>
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Trabalho automático"
        message={pending ? autonomyConfirmText(pending.autonomy) : ''}
        onConfirm={() => {
          if (pending) onChange(pending);
          setPending(null);
        }}
        onCancel={() => setPending(null)}
      />
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">
        {label}
        {hint && <span className="ml-1 normal-case tracking-normal text-fg-dim">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

/** One entry per line. Keeps the raw text while typing so a trailing newline is not eaten. */
function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <textarea
      className="input min-h-[60px] font-mono text-xs"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean));
      }}
    />
  );
}

/** Empty = null (the field's "off"). */
function NumberInput({ value, onChange, min, max, step, placeholder }: { value: number | null; onChange: (v: number | null) => void; min: number; max: number; step?: string; placeholder?: string }) {
  return (
    <input
      type="number"
      className="input"
      value={value ?? ''}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        const n = e.target.value === '' ? null : Number(e.target.value);
        onChange(n === null || Number.isNaN(n) ? null : n);
      }}
    />
  );
}
