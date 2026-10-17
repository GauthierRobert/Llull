/** Shared plumbing of the 07 FTR commands: refusals with stable codes (AF-11) and the result meta every query carries (AF-10, AF-33, AF-35). */

import type { CadDocument } from '../../model/types';
import { type FtrCode, type FtrRefusal, type FtrResultMeta, type FtrUnverifiedInput, FTR_REVIEW_REASON } from '../../model/manufacturing';
import { commandError, rejection } from '../noop';
import type { CommandResult } from '../types';

/**
 * A refused call: unchanged document, `rejected`, and `error = { code, ids, paths, remediation }`.
 * @param paths offending param paths, e.g. `hole.cskAngle`
 */
export function refuse(
  doc: CadDocument,
  command: string,
  code: FtrCode,
  why: string,
  remediation: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  const refusal: FtrRefusal = { code, ids, paths, remediation };
  return rejection(
    doc,
    `${command} rejected: ${code} — ${why}; no-op. ${remediation}`,
    commandError(refusal.code, refusal.remediation, refusal.ids, refusal.paths),
  );
}

/** What a query computed from, to explain it (AF-35). */
export interface Provenance {
  readonly formulas?: FtrResultMeta['provenance']['formulas'];
  readonly inputs?: FtrResultMeta['provenance']['inputs'];
  readonly sources?: readonly string[];
  readonly unverifiedInputs?: readonly FtrUnverifiedInput[];
}

/** The `FtrResultMeta` of a query on `doc`. */
export function resultMeta(
  doc: CadDocument,
  { formulas = {}, inputs = {}, sources = [], unverifiedInputs = [] }: Provenance = {},
): FtrResultMeta {
  return {
    lengthUnit: doc.units,
    angleUnit: 'deg',
    unverified: unverifiedInputs.length > 0,
    unverifiedInputs,
    reviewRequired: true,
    reviewReason: FTR_REVIEW_REASON,
    provenance: { formulas, inputs, sources },
  };
}
