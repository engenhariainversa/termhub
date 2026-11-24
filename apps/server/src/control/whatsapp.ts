/**
 * TER-1201: the chat's (and any MCP client's) view of the person's WhatsApp. `whatsapp_status` and
 * `list_whatsapp_groups` are reads; `send_whatsapp` writes to a third-party system, so in the chat it is
 * always the person's card (chat/gate.ts `irreversibleTools`) showing the destination and the text, and
 * automatic tabs never call it. All act for the signed-in person only. Without a destination the message
 * goes to the number saved on Configurações → WhatsApp; `group` (name or JID) or `number` send elsewhere.
 */
import { isEnabled } from '../features/flags.js';
import { EvolutionError, fetchGroups, type EvolutionGroup } from '../integrations/evolution.js';
import { maskNumber, normalizeNumber, probe, savedTarget, sendToOwner, failureCode, WHATSAPP_TEXT_MAX } from '../whatsapp/service.js';
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

/** The groups shown at most; `query` narrows a long list. */
export const WHATSAPP_GROUPS_MAX = 200;

async function groupsOf(ctx: ControlContext, userId: string): Promise<EvolutionGroup[]> {
  const saved = await savedTarget(ctx.repos, userId);
  if (!saved) throw new ControlError('WHATSAPP_NOT_CONFIGURED', 'O WhatsApp não está configurado: Configurações → WhatsApp');
  try {
    return await fetchGroups(saved.target);
  } catch (err) {
    if (err instanceof EvolutionError) throw new ControlError('WHATSAPP_GROUPS_FAILED', msg('Não consegui listar os grupos do WhatsApp ({{code}})', { code: failureCode(err) }));
    throw err;
  }
}

const folded = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();

export async function listWhatsappGroups(ctx: ControlContext, input: { query?: string }) {
  const userId = await assertOn(ctx);
  const all = await groupsOf(ctx, userId);
  const q = input.query ? folded(input.query) : '';
  const matching = (q ? all.filter((g) => folded(g.name).includes(q)) : all).sort((a, b) => a.name.localeCompare(b.name));
  return { total: matching.length, groups: matching.slice(0, WHATSAPP_GROUPS_MAX), truncated: matching.length > WHATSAPP_GROUPS_MAX };
}

type Destination = { to?: string; shown: { kind: 'own'; number: string } | { kind: 'group'; id: string; name: string } | { kind: 'number'; number: string } };

/** A group by JID or by exact name (accents and case ignored), or a contact's number; none = the person's own. */
async function destinationOf(ctx: ControlContext, userId: string, own: string, input: { group?: string; number?: string }): Promise<Destination> {
  if (input.group && input.number) throw new ControlError('WHATSAPP_TWO_DESTINATIONS', 'Informe só um destino: group ou number');
  if (input.number) {
    const number = normalizeNumber(input.number);
    if (!number) throw new ControlError('WHATSAPP_BAD_NUMBER', 'Número inválido: use só dígitos com o código do país e o DDD (ex.: 5562999998888)');
    return number === own ? { shown: { kind: 'own', number: maskNumber(own) } } : { to: number, shown: { kind: 'number', number } };
  }
  if (input.group) {
    const wanted = input.group.trim();
    const groups = await groupsOf(ctx, userId);
    const matches = wanted.endsWith('@g.us') ? groups.filter((g) => g.id === wanted) : groups.filter((g) => folded(g.name) === folded(wanted));
    if (matches.length === 0) throw new ControlError('WHATSAPP_GROUP_NOT_FOUND', msg('Nenhum grupo do WhatsApp com "{{group}}"; veja list_whatsapp_groups', { group: wanted }));
    if (matches.length > 1) throw new ControlError('WHATSAPP_GROUP_AMBIGUOUS', msg('Há {{count}} grupos chamados "{{group}}"; use o id (list_whatsapp_groups)', { count: matches.length, group: wanted }));
    const [g] = matches;
    return { to: g.id, shown: { kind: 'group', id: g.id, name: g.name } };
  }
  return { shown: { kind: 'own', number: maskNumber(own) } };
}

export async function sendWhatsapp(ctx: ControlContext, input: { text: string; group?: string; number?: string }) {
  const userId = await assertOn(ctx);
  const saved = await ctx.repos.whatsapp.get(userId);
  if (!saved) throw new ControlError('WHATSAPP_NOT_CONFIGURED', 'O WhatsApp não está configurado: Configurações → WhatsApp');
  if (!saved.enabled) throw new ControlError('WHATSAPP_DISABLED', 'O WhatsApp está pausado em Configurações → WhatsApp');
  const destination = await destinationOf(ctx, userId, saved.number, input);
  try {
    await sendToOwner(ctx.repos, userId, input.text, fetch, destination.to);
  } catch (err) {
    if (err instanceof EvolutionError) throw new ControlError('WHATSAPP_SEND_FAILED', msg('O envio pelo WhatsApp falhou ({{code}}); nada foi enviado', { code: failureCode(err) }));
    throw err;
  }
  return { sent: true, to: destination.shown };
}
