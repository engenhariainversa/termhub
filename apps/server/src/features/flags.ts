import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repositories } from '../db/repositories/index.js';
import { HttpError } from '../lib/errors.js';
import { tk } from '../i18n/index.js';

/**
 * Feature flags (TER-1040, docs/feature-flags.md): a feature that ships dark, turned on for the whole
 * instance by an admin (Configurações → Recursos em teste) or for one person to test it, without a
 * deploy. Read on the server only; clients get the resolved values from `/auth/me`, the mobile `/me`
 * and, for the landing, `/api/public/features`.
 *
 * `default` is the value when no admin has touched the flag: off, so a new flag never shows up on an
 * instance by surprise. `title` and `description` (pt-BR keys, translated in `i18n/locales`) are what
 * Configurações → Recursos em teste shows, and `card` is where the flag came from (TER-1187): the screen
 * reads them from `GET /api/feature-flags`, so a new flag never shows up there as its bare key.
 */
interface FlagDefinition {
  default: boolean;
  title: string;
  description: string;
  card: `TER-${number}`;
}

export const FEATURE_FLAGS = {
  /** Subscriptions (epic TER-645): plans, checkout, paywall, trial limits and the provider's webhooks. */
  subscriptions: {
    default: false,
    title: tk('Assinaturas'),
    description: tk('Planos, checkout, paywall e limites do período de teste. Desligado, nada disso aparece na web, no app nem na landing, as rotas de cobrança não existem e os webhooks do provedor de pagamento são ignorados.'),
    card: 'TER-645',
  },
  /** TER-1164: the chat acts without a card by default and the person lists what it must not do. */
  chat_open_permissions: {
    default: false,
    title: tk('Chat: liberado por padrão'),
    description: tk('O chat age sem pedir confirmação e você diz o que ele não pode fazer (bloqueios por projeto ou para todos). Um núcleo fixo continua pedindo: apagar, push forçado, merge, integrações, segredos e contas de IA. Desligado, vale o modelo atual de liberações.'),
    card: 'TER-1164',
  },
  /** TER-1171: the agent tab GC runs for the person, in dry run (records what it would close, closes nothing). */
  tab_gc: {
    default: false,
    title: tk('Coletor de abas (teste)'),
    description: tk('Procura abas de agente paradas há muito tempo (24 h; com erro, 6 h) ou cuja sessão do terminal não existe mais, e registra no feed do projeto o que fecharia. Não fecha nada: é a semana de teste.'),
    card: 'TER-1171',
  },
  /** TER-1171: with `tab_gc` on, the GC warns, keeps and closes for real (and the TER-1138 timer steps aside). */
  tab_gc_live: {
    default: false,
    title: tk('Coletor de abas: fechar de verdade'),
    description: tk('Com o coletor ligado, avisa 30 min antes e fecha as abas paradas, guardando a última resposta do agente. Sem esta, o coletor só simula. Nunca fecha aba trabalhando, esperando você, com run automática, com card em andamento ou fixada. Substitui o "Fechar abas paradas" das máquinas.'),
    card: 'TER-1171',
  },
  /** TER-1170: the "Executar em ordem" option of an epic on the board (the MCP and the dispatcher take it anyway). */
  sequential_epics: {
    default: false,
    title: tk('Épico em ordem'),
    description: tk('Mostra a opção "Executar em ordem" no épico: o trabalho automático pega um card por vez, na ordem do board, e só passa ao próximo quando o anterior estiver em Feito com o PR mesclado.'),
    card: 'TER-1170',
  },
  /** TER-1176: the personal runs API (`/api/v1/runs`), the `runs` token scope and "Runs da API" in Progresso. */
  runs_api: {
    default: false,
    title: tk('API de runs'),
    description: tk('Permite criar tokens com o escopo runs e rodar prompts pela API (/api/v1/runs) nas suas próprias contas de IA e máquinas, e mostra as runs da API no Progresso. Desligado, as rotas não existem e o escopo não aparece.'),
    card: 'TER-1176',
  },
} as const satisfies Record<string, FlagDefinition>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlag[];
export const isFeatureFlag = (v: string): v is FeatureFlag => Object.hasOwn(FEATURE_FLAGS, v);

/** Every flag resolved for one person: what `/auth/me` and the mobile `/me` send as `features`. */
export type FeatureFlags = Record<FeatureFlag, boolean>;

export interface FlagContext {
  repos: Pick<Repositories, 'featureFlags'>;
  /** The signed-in person; null/undefined = nobody (the instance value only). */
  userId?: string | null;
}

/** The instance-wide value: what the admin set, else the default in code. */
export async function instanceValue(flag: FeatureFlag, repos: FlagContext['repos']): Promise<boolean> {
  return (await repos.featureFlags.instanceValue(flag)) ?? FEATURE_FLAGS[flag].default;
}

/**
 * The one check every gated feature goes through: the person's own override wins, else the instance
 * value. No cache on purpose: blue and green read the same rows, so an admin's switch holds on both
 * at once.
 */
export async function isEnabled(flag: FeatureFlag, ctx: FlagContext): Promise<boolean> {
  if (ctx.userId) {
    const own = await ctx.repos.featureFlags.overrideFor(flag, ctx.userId);
    if (own !== null) return own;
  }
  return instanceValue(flag, ctx.repos);
}

/** Every flag for one person (or for nobody, the instance values). */
export async function featuresFor(ctx: FlagContext): Promise<FeatureFlags> {
  const values = await Promise.all(FEATURE_FLAG_KEYS.map((flag) => isEnabled(flag, ctx)));
  return Object.fromEntries(FEATURE_FLAG_KEYS.map((flag, i) => [flag, values[i]])) as FeatureFlags;
}

/** The person a request acts for: the signed-in user (web), else the device's owner (mobile API). */
function requestUserId(request: FastifyRequest): string | null {
  // Typed here rather than through auth/middleware's augmentation, which a type-only build of a file that
  // reaches this one (tsconfig.parity.json) does not load.
  const user = (request as { user?: { id: string } | null }).user;
  return user?.id ?? request.scope?.user.id ?? null;
}

/**
 * `preHandler` for every route of a gated feature (billing, plans, checkout): while the flag is off for
 * this person the route answers exactly like a route that does not exist, so nothing gives it away.
 */
export function requireFeature(flag: FeatureFlag, repos: FlagContext['repos']) {
  return async (request: FastifyRequest) => {
    if (await isEnabled(flag, { repos, userId: requestUserId(request) })) return;
    throw new HttpError(404, tk('Rota não encontrada'), 'NOT_FOUND');
  };
}

/**
 * `preHandler` for a payment provider's webhook, which has no signed-in person: inert (200, nothing
 * read or written, so the provider does not retry) unless the flag is on for the instance or for at
 * least one tester. Once the handler knows whose event it is, it still checks `isEnabled` for that
 * person and drops the event when off.
 */
export function webhookGate(flag: FeatureFlag, repos: FlagContext['repos']) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if ((await instanceValue(flag, repos)) || (await repos.featureFlags.anyOverrideOn(flag))) return;
    request.log.info({ flag }, 'feature flag off: webhook ignored');
    return reply.code(200).send({ ok: true, ignored: true });
  };
}
