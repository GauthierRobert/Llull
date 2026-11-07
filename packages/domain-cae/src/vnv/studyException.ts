/** The human gate of a verification exception (PHY-00 TR-VNV-12, AF-34): what the reviewer signs, and how a stored acceptance is re-verified. */

import type { HumanSignaturePort } from '@core/model/analysis';
import { boundVerdict, documentIdentity, withDocumentUid, type BoundVerdict } from '@core/model/documentUid';
import { humanGatePayload } from '@core/model/humanGate';
import type { CadDocument } from '@core/model/types';
import type { CaseStudy } from './studyState';

/** Codes whose finding a qualified reviewer may accept (a numeric GCI above the target is the owner's call, never accepted). */
export const ACCEPTABLE_CODES = ['VNV_NOT_ASYMPTOTIC', 'VNV_OSCILLATORY', 'VNV_DIVERGENT', 'VNV_ORDER_MISMATCH'] as const;

export const EXCEPTION_ACT = 'acceptance of a verification exception';

/** Result hashes of the levels: the data an acceptance covers. */
export const levelHashes = (study: CaseStudy): string[] => study.levels.map((level) => level.resultsHash);

/** Details the signature covers: the act, the study and its levels, the code and the justification, the document uid. */
export const exceptionDetails = (study: CaseStudy, code: string, justification: string, documentUid: string): Record<string, unknown> =>
  withDocumentUid({ analysisId: study.analysisId, studyId: study.id, code, justification, levelHashes: levelHashes(study) }, documentUid);

export const nonceOf = (signature: unknown): string =>
  typeof signature === 'object' && signature !== null && typeof (signature as { nonce?: unknown }).nonce === 'string'
    ? (signature as { nonce: string }).nonce
    : '';

/**
 * How the exception stored on `study` stands now: `ok` only when its signature verifies (pure, nothing spent) over the study as it is now, for this document.
 * `signed` is the signer the PORT returns for the stored signature: that name, never the stored text, is what readers show.
 * @invariant 'invalid' also covers a study whose level hashes changed since the acceptance
 */
export function exceptionVerdict(
  port: HumanSignaturePort,
  doc: CadDocument,
  study: CaseStudy,
): { readonly verdict: BoundVerdict | 'absent'; readonly signed: { readonly signer: string; readonly signatureId: string } | null } {
  const { exception } = study;
  if (exception === undefined) return { verdict: 'absent', signed: null };
  const { verdict, signed } = boundVerdict(port, exception.signature, exception.documentUid, documentIdentity(doc), (uid) =>
    humanGatePayload(
      EXCEPTION_ACT,
      [study.id],
      exceptionDetails(study, exception.code, exception.justification, uid),
      nonceOf(exception.signature),
    ),
  );
  return { verdict, signed };
}
