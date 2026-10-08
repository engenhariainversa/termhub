import type { HookEntriesState, HooksStatus } from '@termhub/machine-ops';
import type { Machine } from '../db/repositories/types.js';
import { HttpError, localizedOf } from '../lib/errors.js';
import { localeOf, msg, t } from '../i18n/index.js';
import { readHooksStatus } from '../monitor/install.js';
import { claudeAccountDirs, installMachineHooksOn } from '../monitor/machine-hooks.js';
import { ControlError, type ControlContext } from './context.js';

/**
 * The machine screen's hooks card, for the concierge (TER-1023): `get_machine_hooks` reads what the
 * hooks look like on a machine, `install_machine_hooks` runs the same install the screen's button does
 * (`installMachineHooksOn`) behind the chat's confirmation card. Answers states and dirs only — never a
 * config file's content, a hook command or the token.
 */

export const HOOK_TOOLS = ['claude', 'codex', 'cursor'] as const;
export type HookTool = (typeof HOOK_TOOLS)[number];

interface ToolHooks {
  /** the CLI's config dir is on the machine (~/.claude, ~/.codex, ~/.cursor) */
  present: boolean;
  /** some entries of ours are there */
  installed: boolean;
  /** an install would change something: entries not exactly ours, or the forwarding script from another release */
  outdated: boolean;
  state: HookEntriesState;
}

export interface MachineHooksView {
  machine_id: string;
  name: string;
  /** when termhub last installed the hooks there (null: never through termhub) */
  installed_at: string | null;
  script: HooksStatus['script'];
  claude: ToolHooks & { dirs: HooksStatus['claude']['dirs'] };
  codex: ToolHooks & { notify: boolean; trusted: HooksStatus['codex']['trusted'] };
  cursor: ToolHooks;
  notes: string[];
}

function toolView(present: boolean, state: HookEntriesState, script: HooksStatus['script']): ToolHooks {
  const installed = state !== 'missing';
  return { present, installed, outdated: state === 'outdated' || (installed && present && script.outdated), state };
}

function view(machine: Machine, installedAt: string | null, s: HooksStatus, locale: ReturnType<typeof localeOf>): MachineHooksView {
  const notes: string[] = [];
  if (!s.claude.present && !s.codex.present && !s.cursor.present) notes.push(t(locale, 'Nenhum CLI de agente (Claude Code, Codex, Cursor) foi encontrado nesta máquina.'));
  if (s.codex.present && s.codex.trusted !== null && s.codex.trusted !== 'all') {
    notes.push(t(locale, 'O Codex só roda os hooks depois que a pessoa confia neles: abra o Codex na máquina e escolha "Trust all" (ou use /hooks). O termhub não faz isso por ela.'));
  }
  if ([s.claude.state, s.codex.state, s.cursor.state].includes('unreadable')) {
    notes.push(t(locale, 'Algum arquivo de configuração não pôde ser lido ou não é JSON válido; a instalação vai recusá-lo até ele ser corrigido na máquina.'));
  }
  return {
    machine_id: machine.id,
    name: machine.name,
    installed_at: installedAt,
    script: s.script,
    claude: { ...toolView(s.claude.present, s.claude.state, s.script), dirs: s.claude.dirs },
    codex: { ...toolView(s.codex.present, s.codex.state, s.script), notify: s.codex.notify, trusted: s.codex.trusted },
    cursor: toolView(s.cursor.present, s.cursor.state, s.script),
    notes,
  };
}

/** The status read, with the ssh/local path's plain errors turned into an answer the caller sees. */
async function statusOf(ctx: ControlContext, machine: Machine): Promise<HooksStatus> {
  try {
    return await readHooksStatus(machine, await claudeAccountDirs(ctx.repos, machine.id));
  } catch (err) {
    // Agent failures (offline, outdated, what the machine reported) already carry their own code and text.
    if (err instanceof HttpError || err instanceof ControlError) throw err;
    throw new ControlError('MACHINE_UNREACHABLE', err instanceof Error ? localizedOf(err) : msg('Não foi possível ler a configuração da máquina'));
  }
}

export async function getMachineHooks(ctx: ControlContext, input: { machine_id: string }): Promise<MachineHooksView> {
  const machine = await ctx.scoped.machine(input.machine_id);
  const status = await statusOf(ctx, machine);
  const hook = await ctx.repos.machineHooks.findByMachine(machine.id);
  return view(machine, hook?.installed_at ?? null, status, localeOf(ctx.scope.user.locale));
}

const CONFIRM_REQUIRED = () =>
  new ControlError('CONFIRMATION_REQUIRED', msg('Instalar os hooks mexe nos arquivos de configuração da máquina e precisa da confirmação da pessoa no chat. Nada foi alterado: proponha a chamada de novo.'));

/** One line per CLI of what the install changed there: its entries' state before → after. */
export interface HookChange {
  tool: HookTool;
  before: HookEntriesState | 'absent';
  /** null when the machine could not be read again after the install */
  after: HookEntriesState | 'absent' | null;
}

const stateOf = (present: boolean, state: HookEntriesState): HookEntriesState | 'absent' => (present ? state : 'absent');

export async function installMachineHooks(
  ctx: ControlContext,
  input: { machine_id: string; tools?: HookTool[] },
): Promise<{ machine_id: string; name: string; installed_at: string; changes: HookChange[]; script: { before: string | null; after: string | null }; hooks: MachineHooksView | null }> {
  const machine = await ctx.scoped.machine(input.machine_id);
  // The gate asks before this runs on the concierge's token; never without the person's card.
  if (ctx.token?.gated && !ctx.approval) throw CONFIRM_REQUIRED();
  const locale = localeOf(ctx.scope.user.locale);

  // Read first: an agent too old for the status read is told to update before anything is written, and a
  // CLI the person named that is not on the machine stops the call here.
  const before = await statusOf(ctx, machine);
  const missing = (input.tools ?? []).filter((tool) => !before[tool].present);
  if (missing.length) {
    throw new ControlError(
      'CLI_NOT_FOUND',
      msg('{{tools}} não está instalado nesta máquina: os hooks só são instalados para os CLIs que já estão lá. Nada foi alterado.', { tools: missing.join(', ') }),
    );
  }

  let done;
  try {
    done = await installMachineHooksOn(ctx.repos, machine);
  } catch (err) {
    if (err instanceof HttpError || err instanceof ControlError) throw err;
    throw new ControlError('HOOKS_INSTALL_FAILED', err instanceof Error ? localizedOf(err) : msg('Instalação falhou'));
  }
  ctx.log?.info({ machineId: machine.id, claude: done.report.claude, claudeDirs: done.report.claude_dirs.length, codex: done.report.codex, cursor: done.report.cursor }, 'monitor: hooks installed');

  // The install already happened: a second read that fails only leaves the "after" side unknown.
  const after = await statusOf(ctx, machine).catch(() => null);
  const changes = HOOK_TOOLS.map((tool) => ({
    tool,
    before: stateOf(before[tool].present, before[tool].state),
    after: after ? stateOf(after[tool].present, after[tool].state) : null,
  }));
  return {
    machine_id: machine.id,
    name: machine.name,
    installed_at: done.installed_at,
    changes,
    script: { before: before.script.version, after: after ? after.script.version : null },
    hooks: after ? view(machine, done.installed_at, after, locale) : null,
  };
}
