// How many decisions one grouped call carries (TER-1192). Kept free of zod on purpose: the web imports this
// module alone (`@termhub/mobile-api/decision-batch`) and must not pull the schemas into its bundle.

/** The most decisions one grouped call takes, on the web's and the phone's batch routes and in one
 * challenges call (TER-1192). A subagent can ask for dozens of cards in one go, and a group card offers
 * all of them at once; the clients still split a longer list into calls of this size. It was 20, which
 * answered "Dados inválidos" to "Aprovar selecionadas (30)" and to "Recusar todas". */
export const CHAT_DECISION_BATCH_MAX = 100;

/** `items` in runs of at most `CHAT_DECISION_BATCH_MAX`, in order: how a client sends a longer list. */
export function decisionBatches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHAT_DECISION_BATCH_MAX) out.push(items.slice(i, i + CHAT_DECISION_BATCH_MAX));
  return out;
}
