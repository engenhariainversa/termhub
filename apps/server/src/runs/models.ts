import { conciergeModel, modelFamily } from '../chat/concierge-model.js';
import type { Capability, Provider } from './events.js';

/**
 * What a run may use, per provider (TER-1176, spec "Adapters"): the Claude Code tool list, the Codex
 * sandbox, and the model a request resolves to.
 */

export type ClaudeTool = 'Read' | 'Grep' | 'Glob' | 'Edit' | 'Write' | 'Bash';
export type CodexSandbox = 'read-only' | 'workspace-write';
export type ModelClass = 'fast' | 'default' | 'strong';

/** `--tools` / `--allowed-tools` of a Claude Code run: reading always; `edit` adds Edit and Write;
 *  `run_commands` adds Bash. */
export function claudeTools(caps: readonly Capability[]): ClaudeTool[] {
  const tools: ClaudeTool[] = ['Read', 'Grep', 'Glob'];
  if (caps.includes('edit')) tools.push('Edit', 'Write');
  if (caps.includes('run_commands')) tools.push('Bash');
  return tools;
}

/** `-s` of a Codex run: read-only unless it may edit or run commands. */
export function codexSandbox(caps: readonly Capability[]): CodexSandbox {
  return caps.includes('edit') || caps.includes('run_commands') ? 'workspace-write' : 'read-only';
}

const CLAUDE_CLASS: Record<ModelClass, string> = { fast: 'haiku', default: 'sonnet', strong: 'opus' };

/**
 * The model a run passes to the CLI; null = no flag, the CLI's own default.
 *
 * - Claude: an explicit `model`, else the class (fast=haiku, default=sonnet, strong=opus; no class =
 *   default), then filtered by the families the person blocked through `conciergeModel`: a blocked one
 *   becomes the first family still allowed. An explicit model is filtered too: the block means "never
 *   use", whoever asks.
 * - Codex: an explicit `model`, else the project Setup's `models.chatgpt` for default/strong, and the
 *   CLI's default for fast or when the Setup has none. The blocked list holds Claude families only.
 */
export function resolveModel(
  provider: Provider,
  req: { model?: string; model_class?: ModelClass },
  ctx: { blocked: string[]; setupModels: { claude?: string | null; chatgpt?: string | null } },
): string | null {
  const explicit = req.model?.trim() || null;
  if (provider === 'claude') {
    const wanted = explicit ?? CLAUDE_CLASS[req.model_class ?? 'default'];
    return conciergeModel(wanted, ctx.blocked).model;
  }
  if (explicit) return explicit;
  if ((req.model_class ?? 'default') === 'fast') return null;
  return ctx.setupModels.chatgpt?.trim() || null;
}

/** The provider whose ids a model matches: Claude aliases and `claude-*` ids, or OpenAI's `gpt-*`,
 *  `o<digit>*` and `codex-*`. Null for anything else. */
export function providerOfModel(model: string): Provider | null {
  const m = model.trim().toLowerCase();
  if (!m) return null;
  if (modelFamily(m) !== null || m.startsWith('claude') || m === 'opusplan') return 'claude';
  if (/^(gpt-|o\d|codex)/.test(m)) return 'codex';
  return null;
}
