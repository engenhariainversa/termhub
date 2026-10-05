import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from './Modal';
import { DirectoryBrowser } from './DirectoryBrowser';
import { MachineForm } from './MachineForm';
import { STATUS_DOT } from '../lib/machine-status';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { machineLabel } from '../lib/machine-labels';
import type { ProjectInput } from '../lib/types';
import { api, ApiError } from '../lib/api';
import { isValidProjectKey, suggestProjectKey } from '../lib/project-key';
import { tk, useTranslation } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  /** preselects the machine on step 2 (e.g. the "+" on a machine row) */
  machineId?: string;
}

type KeyState = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok' } | { kind: 'taken' } | { kind: 'invalid' };

const keyHint: Record<KeyState['kind'], { text: string; cls: string }> = {
  idle: { text: '', cls: '' },
  checking: { text: tk('verificando…'), cls: 'text-fg-dim' },
  ok: { text: tk('disponível'), cls: 'text-ok' },
  taken: { text: tk('já em uso'), cls: 'text-danger' },
  invalid: { text: tk('formato inválido'), cls: 'text-danger' },
};

/** New-project walkthrough: 1) project (name/key/description) 2) machine 3) directory. */
export function ProjectForm({ open, onClose, machineId }: Props) {
  const { t } = useTranslation();
  const { createProject, machines, statuses } = useData();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [step, setStepRaw] = useState<1 | 2 | 3>(1);
  // an error belongs to the step that raised it
  const setStep = (s: 1 | 2 | 3) => {
    setError(null);
    setStepRaw(s);
  };

  // step 1
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [keyState, setKeyState] = useState<KeyState>({ kind: 'idle' });
  const [description, setDescription] = useState('');

  // step 2
  const [machine, setMachine] = useState<string>(machineId ?? '');
  const [machineForm, setMachineForm] = useState<{ open: boolean; priorIds: Set<string> } | null>(null);

  // step 3
  const [cwd, setCwd] = useState('');
  const [createDir, setCreateDir] = useState(true);
  const [browsing, setBrowsing] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // a directory picked on one machine means nothing on another
  const pickMachine = (id: string) => {
    if (id === machine) return;
    setMachine(id);
    setCwd('');
    setBrowsing(false);
  };

  // suggestion follows the name until the person edits the key by hand
  const onName = (v: string) => {
    setName(v);
    if (!keyEdited) setKey(v.trim() ? suggestProjectKey(v) : '');
  };

  // availability: debounced, invalid keys never hit the server
  useEffect(() => {
    if (!key) return setKeyState({ kind: 'idle' });
    if (!isValidProjectKey(key)) return setKeyState({ kind: 'invalid' });
    setKeyState({ kind: 'checking' });
    let cancelled = false;
    const timer = setTimeout(() => {
      api.projects
        .keyAvailable(key)
        .then((r) => !cancelled && setKeyState(r.available ? { kind: 'ok' } : { kind: r.reason === 'invalid' ? 'invalid' : 'taken' }))
        .catch(() => !cancelled && setKeyState({ kind: 'idle' }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  const step1Ok = !!name.trim() && keyState.kind === 'ok';

  const finish = async (input: ProjectInput) => {
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(input);
      onClose();
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('Erro ao criar projeto'));
      setBusy(false);
    }
  };

  const skip = () => {
    if (busy) return;
    void finish({ name: name.trim(), key, description: description || null });
  };

  const createWithMachine = (e: FormEvent) => {
    e.preventDefault();
    if (busy || !machine || !cwd.trim()) return;
    void finish({ name: name.trim(), key, description: description || null, machine_id: machine, cwd: cwd.trim(), create_dir: createDir });
  };

  return (
    <Modal title={t('Novo projeto')} open={open} onClose={onClose} width={browsing ? 'max-w-2xl' : 'max-w-md'}>
      <p className="mb-3 text-xs text-fg-dim">{t('Passo {{step}} de 3', { step })}</p>

      {step === 1 && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (step1Ok) setStep(2);
          }}
        >
          <div>
            <label className="label" htmlFor="project-name">{t('Nome')}</label>
            <input id="project-name" className="input" value={name} onChange={(e) => onName(e.target.value)} required autoFocus placeholder={t('ex.: meu-app')} />
          </div>
          <div>
            <label className="label" htmlFor="project-key">{t('Chave')}</label>
            <div className="flex items-center gap-2">
              <input
                id="project-key"
                className="input w-40 font-mono uppercase"
                value={key}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10));
                }}
                required
                // i18n-ignore: a sample key
                placeholder="APP"
              />
              <span className={`text-xs ${keyHint[keyState.kind].cls}`}>{keyHint[keyState.kind].text && t(keyHint[keyState.kind].text)}</span>
            </div>
            <p className="mt-1 text-xs text-fg-dim">
              {t('2 a 10 letras ou dígitos, começando com letra. Aparece nas URLs e nos números dos cards (ex.: {{example}}). Não muda depois.', { example: `${key || 'APP'}-12` })}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="project-description">{t('Descrição (opcional)')}</label>
            <textarea id="project-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              {t('Cancelar')}
            </button>
            <button type="submit" className="btn-primary" disabled={!step1Ok}>
              {t('Continuar')}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div>
            <span className="label">{t('Máquina')}</span>
            {machines.length === 0 && <p className="text-xs text-fg-dim">{t('Nenhuma máquina cadastrada ainda.')}</p>}
            <ul className="mt-1 space-y-1">
              {machines.map((m) => {
                const status = statuses[m.id] ?? 'checking';
                return (
                  <li key={m.id}>
                    <label className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5 text-sm hover:bg-bg-3">
                      <input type="radio" name="project-machine" checked={machine === m.id} onChange={() => pickMachine(m.id)} />
                      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} />
                      <span className="truncate">{machineLabel(m)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
          {can('machines', 'create') && (
            <button
              type="button"
              className="btn-ghost border border-line text-xs"
              onClick={() => setMachineForm({ open: true, priorIds: new Set(machines.map((m) => m.id)) })}
            >
              {t('Cadastrar nova máquina')}
            </button>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-2 pt-2">
            <button type="button" className="btn-ghost text-xs" onClick={skip} disabled={busy}>
              {t('Pular por enquanto')}
            </button>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={() => setStep(1)}>
                {t('Voltar')}
              </button>
              <button type="button" className="btn-primary" disabled={!machine} onClick={() => setStep(3)}>
                {t('Continuar')}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <form onSubmit={createWithMachine} className="space-y-3">
          <div>
            <label className="label" htmlFor="project-cwd">{t('Diretório (caminho absoluto na máquina)')}</label>
            <div className="flex gap-2">
              <input id="project-cwd" className="input font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} required placeholder={t('/home/pedro/projetos/meu-app')} />
              <button type="button" className="btn-ghost shrink-0 border border-line" onClick={() => setBrowsing((b) => !b)} title={t('Listar discos e pastas da máquina')}>
                {browsing ? t('Ocultar') : t('Procurar…')}
              </button>
            </div>
            <label className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
              <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} /> {t('criar a pasta na máquina se não existir')}
            </label>
            {browsing && (
              <div className="mt-2">
                <DirectoryBrowser
                  machineId={machine}
                  initialPath={cwd}
                  onSelect={(path) => {
                    setCwd(path);
                    setBrowsing(false);
                  }}
                  onClose={() => setBrowsing(false)}
                />
              </div>
            )}
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setStep(2)}>
              {t('Voltar')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy || !cwd.trim()}>
              {t('Criar projeto')}
            </button>
          </div>
        </form>
      )}

      {machineForm?.open && (
        <MachineForm
          open
          onClose={() => {
            const created = machines.find((m) => !machineForm.priorIds.has(m.id));
            if (created) pickMachine(created.id);
            setMachineForm(null);
          }}
        />
      )}
    </Modal>
  );
}
