/**
 * The reviewer disposition of an acoustic load package (dispose_acoustic_export): the signed act, the fingerprint of what the reviewer judged, and the
 * re-verified state of a stored disposition (a record in the slice proves nothing by itself).
 */

import type { HumanSignaturePort } from '@core/model/analysis';
import type { CadDocument, Entity } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { type SignedState, signedState } from '../shared/signedGate';
import type { VacItem } from './codes';
import { reviewOf } from './model';
import type { AcousticExposure, AcousticReview, AcousticSpectrum } from './types';

export const REVIEW_ACT = 'accept or reject an acoustic load package for qualification use';

export const reviewDetails = (
  decision: string,
  justification: string,
  fingerprint: string,
  documentUid: string,
): Record<string, unknown> => ({ decision, justification, fingerprint, documentUid });

/**
 * sha256 of what the reviewer judges: the exposure (field, incidence, target points, notes), its spectrum (bands, source, grade), the document units and
 * the target solid without its presentation (layer, colour, name, tags, material, decals, pattern seed).
 * @invariant kernel-free and deterministic; any change of a level, a band, the source, the field, a face point or the solid's geometry / placement changes it
 */
export function exposureFingerprint(doc: CadDocument, exposure: AcousticExposure, spectrum: AcousticSpectrum, target: Entity): string {
  const {
    layerId: _layer,
    color: _color,
    name: _name,
    tags: _tags,
    materialId: _material,
    decals: _decals,
    patternSourceId: _pattern,
    ...geometry
  } = target;
  return sha256Hex(canonicalJson({ exposure, spectrum, units: doc.units, target: geometry }));
}

/** The state of a stored review (re-verified through the port over the payload it was signed for); never throws. */
const reviewState = (doc: CadDocument, port: HumanSignaturePort | null, review: AcousticReview): SignedState =>
  signedState(
    doc,
    port,
    {
      act: REVIEW_ACT,
      ids: [review.exposure],
      details: (uid) => reviewDetails(review.decision, review.justification, review.fingerprint, uid),
    },
    review,
  );

/** What the export package says of its review: `fingerprint` is what a reviewer signs (with the decision, justification and document uid). */
export interface PackageReview {
  readonly status: 'none' | 'accepted' | 'rejected' | 'stale' | 'unconfirmed';
  readonly fingerprint: string;
  readonly signer?: string;
  readonly signatureId?: string;
  readonly justification?: string;
  /** Why a stored disposition does not count: its signature does not verify for this document, or no port can confirm it. */
  readonly unconfirmed?: Exclude<SignedState, 'ok'>;
}

const PENDING_REMEDIATION =
  'a qualified reviewer must confirm the spectrum, the field type and the faces and sign dispose_acoustic_export in the desktop app (an agent cannot)';

/** The review of the package of `exposure` (current fingerprint `fingerprint`) and its item: none for a confirmed acceptance. */
export function packageReview(
  doc: CadDocument,
  port: HumanSignaturePort | null,
  exposure: string,
  fingerprint: string,
): { readonly review: PackageReview; readonly item: VacItem | null } {
  const stored = reviewOf(doc, exposure);
  const pending = (
    status: PackageReview['status'],
    message: string,
    extra: Partial<PackageReview> = {},
  ): ReturnType<typeof packageReview> => ({
    review: { status, fingerprint, ...extra },
    item: { code: 'VAC_REVIEW_PENDING', severity: 'warning', message, remediation: PENDING_REMEDIATION },
  });
  if (stored === undefined) return pending('none', 'this package has no reviewer disposition; it feeds a qualification analysis');
  const signedBy = { signer: stored.signer, signatureId: stored.signatureId };
  if (stored.fingerprint !== fingerprint)
    return pending(
      'stale',
      `the disposition by ${stored.signer} (signature ${stored.signatureId}) was made for an earlier exposure, spectrum or target: it no longer applies`,
      signedBy,
    );
  const state = reviewState(doc, port, stored);
  if (state !== 'ok')
    return pending('unconfirmed', `the stored disposition by ${stored.signer} is not confirmed (${state}): it counts for nothing`, {
      ...signedBy,
      unconfirmed: state,
    });
  const confirmed = { status: stored.decision, fingerprint, ...signedBy, justification: stored.justification } as const;
  if (stored.decision === 'accepted') return { review: confirmed, item: null };
  return {
    review: confirmed,
    item: {
      code: 'VAC_REVIEW_REJECTED',
      severity: 'warning',
      message: `the reviewer ${stored.signer} rejected this package: ${stored.justification}`,
      remediation: 'do not use the package; correct the exposure, spectrum or faces the justification names, then ask for a new review',
    },
  };
}
