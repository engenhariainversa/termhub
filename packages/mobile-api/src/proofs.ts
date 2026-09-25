/** The base + path a signed decision proof is bound to, dropping the query string and any
 * trailing slash on the base — the app and the server must agree byte-for-byte on what was signed. */
export const canonicalHtu = (base: string, path: string) => base.replace(/\/$/, '') + path.split('?')[0];

/** Which decision a PIN proof is for. Signed into the message, so a proof made for "Autorizar" can
 * never be spent on "Permitir sempre nesta aba" (a 24 h grant) — or the other way round. */
export type PinDecision = 'approve' | 'approve_tab';

/** What the device's PIN key signs to approve a pending action (or approve it and trust its tab): the
 * challenge and the action it applies to, newline-separated, so a proof for one action or challenge can
 * never be replayed for another. */
export const decisionProofMessage = (challenge: string, actionId: string, decision: PinDecision) => `${challenge}\n${actionId}\n${decision}`;
