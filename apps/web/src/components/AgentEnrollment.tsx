import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './MachineForm';
import { api } from '../lib/api';
import { track } from '../lib/analytics';
import { Trans, tk, useTranslation } from '../i18n';
import type { Machine } from '../lib/types';

const POLL_MS = 3000;

export type ClientOs = 'linux' | 'macos';

/** Lowest Node major the agent runs on: `engines.node` of apps/agent/package.json (a test keeps them equal). */
export const MIN_NODE_MAJOR = 20;
/** How long the Linux command waits for another apt/dpkg run to release its lock, in seconds. */
export const APT_LOCK_WAIT_S = 120;

/** What the install commands print on the machine: pt-BR keys, translated when the command is built. */
const MSG = {
  node: tk('O termhub-agent precisa do Node 20 ou mais novo, com o npm. Instale (https://nodejs.org ou nvm) e rode o comando de novo.'),
  aptWait: tk('O apt está em uso por outro processo; esperando liberar (até 2 minutos)...'),
  aptHeld: tk('O apt continua em uso por outro processo (PID, nome e há quanto tempo roda):'),
  aptHeldFix: tk(
    'Se for uma atualização em andamento, espere terminar e rode o comando de novo. Se estiver parado há muito tempo, finalize esse processo (kill PID), rode dpkg --configure -a (com sudo, se não for root) e depois este comando de novo.',
  ),
  noManager: tk('Instale tmux, make, g++ e python3 com o gerenciador de pacotes do sistema e rode o comando de novo.'),
  clt: tk('Conclua a instalação das Command Line Tools e rode o comando de novo.'),
};

type Translate = (key: string) => string;
const asIs: Translate = (key) => key;
/** Single-quotes a message for the shell, whatever the translation holds. */
const sq = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * Installs the agent on a Linux machine. The agent attaches every terminal to tmux, and npm builds
 * node-pty from source there (its release ships no Linux prebuild), so tmux, a C++ toolchain and
 * python3 come first, through the one package manager the machine has. `if/elif` picks exactly one
 * branch, and `fi && npm` only installs the agent when that branch succeeded — a failed apt never
 * falls through to another manager nor reaches npm. `sudo` only when not running as root.
 *
 * - Node is checked first, so a machine without it (or with an old one) hears it before anything
 *   is installed instead of at the npm step.
 * - A machine that already has tmux, make, g++ and python3 skips the package manager altogether.
 * - apt may be busy (unattended-upgrades on a VPS's first boot, or a stuck run): `th_apt` lets apt
 *   wait for the dpkg lock itself (`DPkg::Lock::Timeout`) and retries while another apt/dpkg
 *   process is alive, because `apt-get update` fails at once on the lists lock. When the lock is
 *   still held after `APT_LOCK_WAIT_S`, it names the holders and says what to do — never to delete
 *   the lock file. A failure with no other apt process around is a real one and is not retried.
 *   `unattended-upgrade-shutdown` is left out of the holders: Ubuntu keeps that daemon running all
 *   the time under the same process name (`unattended-upgr`) as a real unattended upgrade.
 */
export function linuxInstallCommand(t: Translate = asIs): string {
  return [
    'SUDO=$([ "$(id -u)" -eq 0 ] || echo sudo)',
    'th_apt() {',
    '  th_start=$(date +%s) th_waiting=',
    `  until $SUDO env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=${APT_LOCK_WAIT_S} "$@"; do`,
    '    th_held=$(ps -eo pid=,etime=,comm=,args= 2>/dev/null | while read -r p e c a; do case "$c $a" in *unattended-upgrade-shutdown*) ;; apt\\ *|apt-get\\ *|apt.systemd*|aptitude*|dpkg\\ *|unattended-upgr*) echo "  PID $p ($c) $e";; esac; done)',
    '    [ -n "$th_held" ] || return 1',
    `    if [ $(($(date +%s) - th_start)) -ge ${APT_LOCK_WAIT_S} ]; then echo ${sq(t(MSG.aptHeld))}; echo "$th_held"; echo ${sq(t(MSG.aptHeldFix))}; return 1; fi`,
    `    [ -n "$th_waiting" ] || echo ${sq(t(MSG.aptWait))}`,
    '    th_waiting=1; sleep 5',
    '  done',
    '}',
    `if ! command -v npm >/dev/null || ! node -e 'process.exit(parseInt(process.versions.node) >= ${MIN_NODE_MAJOR} ? 0 : 1)' 2>/dev/null; then echo ${sq(t(MSG.node))}; false`,
    'elif command -v tmux >/dev/null && command -v make >/dev/null && command -v g++ >/dev/null && command -v python3 >/dev/null; then :',
    'elif command -v apt-get >/dev/null; then th_apt update && th_apt install -y build-essential python3 tmux',
    'elif command -v dnf >/dev/null; then $SUDO dnf group install -y "Development Tools" && $SUDO dnf install -y python3 tmux',
    'elif command -v pacman >/dev/null; then $SUDO pacman -S --noconfirm --needed base-devel python tmux',
    `else echo ${sq(t(MSG.noManager))}; false`,
    'fi && npm i -g @termhub/agent && termhub-agent --version',
  ].join('\n');
}

/**
 * Installs the agent on macOS. node-pty ships macOS prebuilds, but npm falls back to compiling it
 * when they do not load, so the Command Line Tools are checked first: `xcode-select --install`
 * opens the system installer and returns right away, hence the stop-and-rerun instead of going on.
 * Each step is grouped and joined with `&&`, so a failure stops the chain before npm.
 */
export function macosInstallCommand(t: Translate = asIs): string {
  return [
    `{ xcode-select -p >/dev/null 2>&1 || { xcode-select --install; echo ${sq(t(MSG.clt))}; false; }; } &&`,
    '{ command -v tmux >/dev/null || brew install tmux; } &&',
    'npm i -g @termhub/agent && termhub-agent --version',
  ].join('\n');
}

/** The commands with their messages in pt-BR, the source language. */
export const LINUX_INSTALL_COMMAND = linuxInstallCommand();
export const MACOS_INSTALL_COMMAND = macosInstallCommand();

/** The install command of each OS, with its messages in the language of `t`. */
export function installCommand(os: ClientOs, t: Translate = asIs): string {
  return os === 'linux' ? linuxInstallCommand(t) : macosInstallCommand(t);
}

/** Picks the tab shown first from the browser's OS: macOS on a Mac, Linux everywhere else. */
export function detectClientOs(nav: Pick<Navigator, 'platform' | 'userAgent'> & { userAgentData?: { platform?: string } } = navigator): ClientOs {
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
  return /mac/i.test(platform) && !/iphone|ipad|ipod/i.test(nav.userAgent || '') ? 'macos' : 'linux';
}

const OS_LABELS: Record<ClientOs, string> = { linux: 'Linux', macos: 'macOS' };
/** Puts npm's global binaries on the PATH (a shell command: never translated). */
const PATH_FIX = 'export PATH="$(npm prefix -g)/bin:$PATH"';

/** The `termhub-agent connect` command the user pastes on the target machine. */
export function enrollCommand(origin: string, token: string): string {
  return `termhub-agent connect --url ${origin} --token ${token}`;
}

interface Step {
  title: string;
  command: string;
  note?: string;
  hint?: string;
  /** Rendered as a warning callout below the command (for the errors people actually hit). */
  troubleshoot?: React.ReactNode;
}

interface Props {
  machine: Machine;
  token: string;
  onConnected?: () => void;
}

function StepItem({ index, step }: { index: number; step: Step }) {
  return (
    <li>
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-4 text-[10px] font-semibold text-fg">{index}</span>
        <span className="font-medium text-fg">{step.title}</span>
      </div>
      <div className="ml-7 mt-1">
        <code className="block max-h-40 select-all overflow-auto whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-[11px] text-fg-muted">{step.command}</code>
        <div className="mt-0.5 flex justify-end">
          <CopyButton text={step.command} />
        </div>
        {step.note && <p className="mt-1 text-[11px] text-warn">{step.note}</p>}
        {step.hint && <p className="mt-1 text-[11px] text-fg-dim">{step.hint}</p>}
        {step.troubleshoot && (
          <div className="mt-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px]">{step.troubleshoot}</div>
        )}
      </div>
    </li>
  );
}

export function AgentEnrollment({ machine, token, onConnected }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ClientOs>(() => detectClientOs());
  const [online, setOnline] = useState(false);
  const [os, setOs] = useState<string | null>(null);
  const [agentVersion, setAgentVersion] = useState<string | null>(null);
  const notifiedRef = useRef(false);
  // Kept up to date in its own effect and read from the polling effect below, so that an
  // `onConnected` prop recreated on every parent render (a common case — see MachineForm,
  // which re-renders whenever DataContext changes, e.g. the 30 s status loop) does not
  // retrigger the polling effect and restart the interval / re-fire `poll()` immediately.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    // one funnel entry per enrollment shown (create or token rotation), never the machine itself
    track('machine_enroll_start');

    const poll = async () => {
      try {
        const r = await api.machines.status(machine.id);
        if (cancelled) return;
        if (r.online) {
          setOnline(true);
          setOs(r.os ?? null);
          setAgentVersion(r.agent_version ?? null);
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          if (!notifiedRef.current) {
            notifiedRef.current = true;
            track('machine_connected', { os: r.os ?? 'unknown' });
            onConnectedRef.current?.();
          }
        }
      } catch {
        // transient network/auth hiccup while waiting for the agent — keep polling
      }
    };

    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [machine.id]);

  const origin = window.location.origin;
  const steps: Step[] = [
    {
      title: tab === 'linux' ? t('Instalar tmux, ferramentas de compilação e o agente') : t('Instalar o tmux e o agente'),
      command: installCommand(tab, (key) => t(key)),
      hint:
        tab === 'linux'
          ? t('Precisa de Node 20+ (o comando confere antes). Se faltar tmux, make, g++ ou python3, instala com apt, dnf ou pacman (com sudo quando não for root): o npm compila o node-pty.')
          : t('Precisa de Node 20+ e do Homebrew. Se faltarem as Command Line Tools, o comando abre o instalador e para: conclua e rode de novo.'),
      troubleshoot: (
        <>
          <p className="font-semibold text-warn">{t('Deu "command not found"?')}</p>
          <ul className="mt-1 space-y-1 text-fg">
            <li>
              {tab === 'linux' ? (
                <Trans
                  i18nKey='Rode o comando acima de novo e veja se o <0>npm i -g</0> terminou sem erro (um "gyp ERR!" ou "not found: make" quer dizer que faltam as ferramentas de compilação).'
                  components={[<code key="c" className="rounded bg-bg-2 px-1 font-mono text-fg-muted" />]}
                />
              ) : (
                <Trans
                  i18nKey="Rode o comando acima de novo e veja se o <0>npm i -g</0> terminou sem erro."
                  components={[<code key="c" className="rounded bg-bg-2 px-1 font-mono text-fg-muted" />]}
                />
              )}
            </li>
            <li>
              <Trans i18nKey="Usa <0>asdf</0>? Rode" components={[<span key="a" className="font-medium" />]} />{' '}
              <code className="rounded bg-bg-2 px-1 font-mono text-fg-muted">asdf reshim nodejs</code>{/* i18n-ignore */}
            </li>
            <li>
              {t('Senão, o diretório de binários globais do npm não está no PATH:')}
              <code className="mt-0.5 block select-all whitespace-pre-wrap break-all rounded bg-bg-2 px-1.5 py-1 font-mono text-fg-muted">
                {PATH_FIX}
              </code>
              <span className="text-fg-dim">{t('(e adicione essa linha ao ~/.zshrc ou ~/.bashrc)')}</span>
            </li>
          </ul>
        </>
      ),
    },
    {
      title: t('Conectar'),
      command: enrollCommand(origin, token),
      note: t('Esse token só aparece agora, é de uso único e vale 15 minutos. Se expirar, gere outro em Parear de novo.'),
    },
    {
      title: t('Instalar como serviço'),
      command: 'termhub-agent service install',
      hint: tab === 'linux' ? t('sobe no boot, sem sudo; rode loginctl enable-linger $USER uma vez para seguir rodando depois do logout') : t('sobe no login, sem sudo'),
    },
  ];

  return (
    <div className="space-y-3 text-sm">
      <div role="tablist" aria-label={t('Sistema da máquina')} className="flex gap-1">
        {(Object.keys(OS_LABELS) as ClientOs[]).map((key) => (
          <button
            key={key}
            id={`enroll-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={key === tab}
            aria-controls="enroll-steps"
            className={key === tab ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab(key)}
          >
            {OS_LABELS[key]}
          </button>
        ))}
      </div>
      <div id="enroll-steps" role="tabpanel" aria-labelledby={`enroll-tab-${tab}`} className="space-y-3">
        <ol className="space-y-3">
          {steps.map((step, i) => (
            <StepItem key={step.title} index={i + 1} step={step} />
          ))}
        </ol>
        {tab === 'macos' && (
          <p className="rounded-md border border-line bg-bg p-2 text-[11px] text-fg-dim">
            <Trans
              i18nKey="Se o projeto estiver em Documents, Desktop ou num disco externo, conceda Acesso Total ao Disco ao node quando o sistema pedir — <0>termhub-agent doctor</0> mostra o que falta."
              components={[<code key="c" className="font-mono" />]}
            />
          </p>
        )}
      </div>
      <div className="rounded-md border border-line bg-bg p-2 text-xs">
        {online ? (
          <span className="text-ok">
            {t('conectado ✓ · {{os}} · agente {{version}}', { os: os ?? t('SO ?'), version: agentVersion ?? '?' })}
          </span>
        ) : (
          <span className="text-fg-dim">{t('aguardando conexão…')}</span>
        )}
      </div>
    </div>
  );
}
