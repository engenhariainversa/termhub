import { z } from 'zod';

/**
 * Account deletion from the phone (TER-720). The request needs a PIN proof over a decision
 * challenge issued for this fixed action id, signed with the word `delete_account`
 * (`decisionProofMessage(challenge, ACCOUNT_DELETION_ACTION_ID, 'delete_account')`), so no other
 * proof (an approval, a token renewal) can be spent on it.
 */
export const ACCOUNT_DELETION_ACTION_ID = 'account_deletion';

/** Days between the request and the deletion for good; signing in during them can cancel it. */
export const ACCOUNT_DELETION_GRACE_DAYS = 30;

export const accountDeletionStatus = z.object({
  pending: z.boolean(),
  requested_at: z.string().nullable(),
  /** When the account is deleted for good; null when no deletion is pending. */
  scheduled_at: z.string().nullable(),
});
export type AccountDeletionStatus = z.infer<typeof accountDeletionStatus>;

export const accountDeletionBody = z.object({ challenge: z.string().min(1).max(128), pin_proof: z.string().min(1).max(128) });
export type AccountDeletionBody = z.infer<typeof accountDeletionBody>;

/** Every route but the account-deletion ones answers this code while a deletion is pending. */
export const ACCOUNT_PENDING_DELETION = 'ACCOUNT_PENDING_DELETION';
