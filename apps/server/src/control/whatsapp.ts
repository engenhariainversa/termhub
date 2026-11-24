/**
 * TER-1201: the chat's (and any MCP client's) view of the person's WhatsApp. `whatsapp_status` is a read;
 * `send_whatsapp` writes to a third-party system, so in the chat it is always the person's card
 * (chat/gate.ts `irreversibleTools`), and automatic tabs never call it. Both act for the signed-in
 * person only, and the message goes to the number saved on Configurações → WhatsApp: no destination
 * argument exists.
 */
import { isEnabled } from '../features/flags.js';
import { EvolutionError } from '../integrations/evolution.js';
import { maskNumber, probe, savedTarget, sendToOwner, failureCode, WHATSAPP_TEXT_MAX } from '../whatsapp/service.js';
import { ControlError, type ControlContext } from './context.js';
import { localeOf, msg, t } from '../i18n/index.js';

export const WHATSAPP_TOOL_TEXT_MAX = WHATSAPP_TEXT_MAX;

async function assertOn(ctx: ControlContext): Promise<string> {
  const userId = ctx.scope.user.id;
  if (!(await isEnabled('whatsapp', { repos: ctx.repos, userId }))) throw new ControlError('WHATSAPP_OFF', 'O WhatsApp está desligado (recurso em teste "WhatsApp" em Configurações → Recursos em teste)');
  return userId;
}

export async function whatsappStatus(ctx: ControlContext) {
  const userId = await assertOn(ctx);
  const saved = await savedTarget(ctx.repos, userId);
  if (!saved) return { configured: false, hint: t(localeOf(ctx.scope.user.locale), 'Configure em Configurações → WhatsApp: servidor, API key, instância e número.') };
  const { settings, target } = saved;
  const connection = await probe(target);
  return {
    configured: true,
    enabled: settings.enabled,
    server: new URL(settings.server_url).host,
    instance: settings.instance,
    number: maskNumber(settings.number),
    notices: { needs_you: settings.notify_needs_you, done: settings.notify_done },
    connection: connection.ok ? { ok: true, state: connection.state } : { ok: false, error: connection.code },
    last_sent_at: settings.last_sent_at,
    last_error: settings.last_error ? { code: settings.last_error, at: settings.last_error_at } : null,
  };
}

export async function sendWhatsapp(ctx: ControlContext, input: { text: string }) {
  const userId = await assertOn(ctx);
  const saved = await ctx.repos.whatsapp.get(userId);
  if (!saved) throw new ControlError('WHATSAPP_NOT_CONFIGURED', 'O WhatsApp não está configurado: Configurações → WhatsApp');
  if (!saved.enabled) throw new ControlError('WHATSAPP_DISABLED', 'O WhatsApp está pausado em Configurações → WhatsApp');
  try {
    await sendToOwner(ctx.repos, userId, input.text);
  } catch (err) {
    if (err instanceof EvolutionError) throw new ControlError('WHATSAPP_SEND_FAILED', msg('O envio pelo WhatsApp falhou ({{code}}); nada foi enviado', { code: failureCode(err) }));
    throw err;
  }
  return { sent: true, to: maskNumber(saved.number) };
}
