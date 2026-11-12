/**
 * Recursos em teste through MCP (TER-1186): the chat lists the flags the person may switch on the
 * Configurações › Recursos em teste screen and sets or clears their own override, the same write the
 * screen's "Valor próprio por pessoa" makes (`repos.featureFlags.setOverride` / `removeOverride`). Only the
 * person's own account: never the instance value, another person's override, nor a flag in
 * `MCP_HIDDEN_FLAGS`. Turning one on is a card in the chat (the gate classes it `write`); turning one off
 * is a brake and runs at once. Agent tabs never reach it (tab allowlist, automatic deny list, and here).
 */
import { recordSecurityEvent } from '../auth/audit.js';
import { FEATURE_FLAG_COPY, FEATURE_FLAGS, isFeatureFlag, MCP_FLAG_KEYS, MCP_HIDDEN_FLAGS, type FeatureFlag } from '../features/flags.js';
import { msg } from '../i18n/index.js';
import { ControlError, type ControlContext } from './context.js';

/** Where the person's effective value comes from: the code's default, the instance switch, or their own override. */
export type FlagSource = 'default' | 'instance' | 'override';

export interface FeatureFlagView {
  key: FeatureFlag;
  /** pt-BR, the screen's copy */
  name: string;
  description: string;
  /** the value in force for this person */
  enabled: boolean;
  source: FlagSource;
  /** the value for everyone (the admin's switch, else the default in code) */
  instance: boolean;
  /** this person's own value; null = none (the instance value applies) */
  override: boolean | null;
}

function refuseTab(ctx: ControlContext): void {
  if (ctx.token?.tab) throw new ControlError('FORBIDDEN', msg('Só a pessoa ou o chat dela trocam os recursos em teste, nunca um agente numa aba.'));
}

async function viewOf(ctx: ControlContext, key: FeatureFlag): Promise<FeatureFlagView> {
  const userId = ctx.scope.user.id;
  const [own, row] = await Promise.all([ctx.repos.featureFlags.overrideFor(key, userId), ctx.repos.featureFlags.instanceValue(key)]);
  const instance = row ?? FEATURE_FLAGS[key].default;
  const source: FlagSource = own !== null ? 'override' : row !== null ? 'instance' : 'default';
  return { key, name: FEATURE_FLAG_COPY[key].label, description: FEATURE_FLAG_COPY[key].description, enabled: own ?? instance, source, instance, override: own };
}

/** `list_feature_flags`: every flag the chat may switch, resolved for the person. */
export async function listFeatureFlags(ctx: ControlContext): Promise<{ flags: FeatureFlagView[] }> {
  refuseTab(ctx);
  return { flags: await Promise.all(MCP_FLAG_KEYS.map((key) => viewOf(ctx, key))) };
}

/**
 * `set_feature_flag`: the person's own override. `enabled` true or false sets it; null removes it (back to
 * the instance value). Audited like the screen's override (`feature_flag.override`), marked `via: mcp`.
 */
export async function setFeatureFlag(ctx: ControlContext, input: { flag: string; enabled: boolean | null }): Promise<{ flag: FeatureFlagView; changed: boolean }> {
  refuseTab(ctx);
  if (!isFeatureFlag(input.flag) || MCP_HIDDEN_FLAGS.has(input.flag)) {
    throw new ControlError('FLAG_NOT_ALLOWED', msg('Este recurso em teste não pode ser trocado pelo chat. Veja os que podem com list_feature_flags.'));
  }
  const key = input.flag;
  const user = ctx.scope.user;
  const before = await ctx.repos.featureFlags.overrideFor(key, user.id);
  if (input.enabled === null) {
    if (before !== null) await ctx.repos.featureFlags.removeOverride(key, user.id);
  } else if (before !== input.enabled) {
    await ctx.repos.featureFlags.setOverride(key, user.id, input.enabled, user.id);
  }
  const changed = before !== input.enabled;
  if (changed) {
    ctx.log?.info({ flag: key, userId: user.id, enabled: input.enabled }, 'feature flag: own override set through MCP');
    await recordSecurityEvent(ctx.repos, {
      actor_id: user.id,
      actor_email: user.email,
      action: 'feature_flag.override',
      target_type: 'user',
      target_id: user.id,
      target_label: user.email,
      meta: { flag: key, enabled: input.enabled, via: 'mcp', conversation_id: ctx.token?.chat_conversation_id ?? null },
    });
  }
  return { flag: await viewOf(ctx, key), changed };
}
