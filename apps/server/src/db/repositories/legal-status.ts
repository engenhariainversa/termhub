/**
 * Which versions of the Terms of Use and of the Privacy Policy a person still has to accept (TER-742,
 * spec 2026-10-07-legal-acceptance-design). Pure: the repository loads the rows, this decides.
 */

export const LEGAL_DOCUMENTS = ['terms', 'privacy'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export const LEGAL_CHANNELS = ['web', 'mobile', 'checkout'] as const;
export type LegalChannel = (typeof LEGAL_CHANNELS)[number];

/** A registered version, as the API serves it. */
export interface LegalVersion {
  id: string;
  document: LegalDocument;
  /** as printed in the document ("1", "1.1") */
  version: string;
  /** ISO 8601 */
  effective_at: string;
  url: string;
  /** false = a minor change (typo, contact data): listed, but nobody is asked again */
  requires_acceptance: boolean;
  /** what changed (pt-BR), or null */
  summary: string | null;
}

export interface LegalStatus {
  /** in force and not accepted yet: the interactive clients block until these are accepted */
  pending: LegalVersion[];
  /** registered for a future date and not accepted yet: the banner, which may accept them early */
  upcoming: LegalVersion[];
}

export const EMPTY_LEGAL_STATUS: LegalStatus = { pending: [], upcoming: [] };

const at = (v: LegalVersion) => Date.parse(v.effective_at);

/**
 * Per document, only versions with `requires_acceptance` count:
 *  - pending: the latest one with `effective_at <= now`, unless the person accepted it or a newer
 *    version of the same document (accepting a newer version also satisfies an older one);
 *  - upcoming: the earliest one with `effective_at > now` not accepted (nor covered by a newer acceptance).
 * `acceptedIds` may hold ids of any version, relevant or not.
 */
export function legalStatus(versions: readonly LegalVersion[], acceptedIds: Iterable<string>, now: Date): LegalStatus {
  const accepted = new Set(acceptedIds);
  const nowMs = now.getTime();
  const out: LegalStatus = { pending: [], upcoming: [] };
  for (const document of LEGAL_DOCUMENTS) {
    const ofDoc = versions.filter((v) => v.document === document);
    /** the newest effective date among this document's accepted versions; -Infinity when none */
    const acceptedUpTo = ofDoc.filter((v) => accepted.has(v.id)).reduce((max, v) => Math.max(max, at(v)), -Infinity);
    const covered = (v: LegalVersion) => accepted.has(v.id) || acceptedUpTo >= at(v);
    const relevant = ofDoc.filter((v) => v.requires_acceptance);

    const inForce = relevant.filter((v) => at(v) <= nowMs).sort((a, b) => at(b) - at(a))[0];
    if (inForce && !covered(inForce)) out.pending.push(inForce);

    const next = relevant
      .filter((v) => at(v) > nowMs)
      .sort((a, b) => at(a) - at(b))
      .find((v) => !covered(v));
    if (next) out.upcoming.push(next);
  }
  return out;
}

/** The ids a person may accept right now: what the status lists (the accept route refuses the rest). */
export function acceptableIds(status: LegalStatus): Set<string> {
  return new Set([...status.pending, ...status.upcoming].map((v) => v.id));
}
