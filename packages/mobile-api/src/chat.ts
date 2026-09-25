import { z } from 'zod';

export const mobileMessageBody = z.object({ text: z.string().trim().min(1).max(8000), project_id: z.string().min(1).max(64).nullish() });
export const sendAccepted = z.object({ conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string() });
export const mobileDecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('deny') }),
  z.object({ decision: z.literal('approve'), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) }),
  /** Approve *and* trust the tab for send_input in this conversation (24 h max). PIN-proven like approve. */
  z.object({ decision: z.literal('approve_tab'), challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) }),
]);

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts), which is the judge: only
 * `send_input` to a tab, never answering a permission. Decides whether the card offers the button. */
export function isTabGrantable(action: { tool: string; args: unknown; tab_id: string | null }): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

export const chatProjectItem = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  busy: z.boolean(),
  pending_confirmations: z.number().int(),
  last_message_at: z.string().nullable(),
});
export const chatProjectsResponse = z.object({ projects: z.array(chatProjectItem) });
export const hostOptionsResponse = z.object({
  machines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      agent_version: z.string().nullable(),
      accounts: z.array(z.object({ id: z.string(), label: z.string(), config_dir: z.string().nullable() })),
    })
  ),
});
