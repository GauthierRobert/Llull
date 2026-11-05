/** Mesh-adequacy gate of compute_margins (FR-INT-06, TR-INT-08): rows of an inadequate result are not assessed unless the caller accepts the mesh. */

import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { blocksAssessment, inadequacyReasons } from '../results/adequacy';

export const ACCEPT_INADEQUATE_MESH = 'acceptInadequateMesh';

/** The fields of a margin row the gate reads (the row type itself lives in computeMargins, which imports this module). */
export interface GateRow {
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface GatedRows<R extends GateRow> {
  readonly rows: readonly R[];
  /** The rows were replaced by `not_assessed` rows. */
  readonly gated: boolean;
  /** `['acceptInadequateMesh']` when the caller's acceptance restored numeric states of an inadequate result, else empty. */
  readonly overrides: readonly string[];
  /** Why the mesh is inadequate (empty when it is not). */
  readonly reasons: readonly string[];
}

/**
 * `FEA_MESH_INADEQUATE` rows for an `inadequate` result: no margin, status `NOT_ASSESSED`, state `not_assessed`, no disposition to ask for.
 * @invariant adequate / marginal results pass through untouched (marginal is a warning: `adequacyWarnings`); `unmeasured` gates like `inadequate`; `accept` restores the numeric rows and is recorded in `overrides`
 */
export function gateRows<R extends GateRow>(rows: readonly R[], adequacy: FeMeshAdequacy, accept: boolean): GatedRows<R> {
  const reasons = inadequacyReasons(adequacy);
  if (!blocksAssessment(adequacy)) return { rows, gated: false, overrides: [], reasons: [] };
  if (accept) return { rows, gated: false, overrides: [ACCEPT_INADEQUATE_MESH], reasons };
  return {
    rows: rows.map(
      (row) =>
        ({
          ...row,
          ms: null,
          status: 'NOT_ASSESSED',
          state: 'not_assessed',
          code: 'FEA_MESH_INADEQUATE',
          disposition: 'none',
          statusLabel: 'NOT ASSESSED (inadequate mesh)',
          meshAdequacy: adequacy.verdict,
        }) as R,
    ),
    gated: true,
    overrides: [],
    reasons,
  };
}

/** The headline of a NOT ASSESSED result (compute_margins summary). */
export const notAssessedText = (reasons: readonly string[]): string =>
  `NOT ASSESSED (FEA_MESH_INADEQUATE: ${reasons.join('; ')}; refine the mesh, or pass acceptInadequateMesh: true on the engineer's decision)`;

/** `FEA_MESH_MARGINAL: ...` when the mesh is marginal (a thin region under 75 % of the layer budget; not gated), else empty. */
export const marginalWarnings = (adequacy: FeMeshAdequacy): string[] =>
  adequacy.verdict === 'marginal'
    ? [`FEA_MESH_MARGINAL: ${inadequacyReasons(adequacy).join('; ')}; the result is not gated, refine the thin region`]
    : [];

/** `data.warnings` entries of the gate: the refusal, the acceptance override, and FEA_MESH_MARGINAL. */
export function adequacyWarnings(gate: GatedRows<GateRow>, adequacy: FeMeshAdequacy): string[] {
  return [
    ...(gate.gated ? [`FEA_MESH_INADEQUATE: ${gate.reasons.join('; ')}`] : []),
    ...(gate.overrides.length > 0 ? [`FEA_MESH_INADEQUATE accepted by acceptInadequateMesh: ${gate.reasons.join('; ')}`] : []),
    ...marginalWarnings(adequacy),
  ];
}

/** `not_assessed` when a row is not assessed, else `fail` / `marginal` / `pass` by the worst regular (non-singular) row. */
export function overallOf(rows: readonly GateRow[]): 'pass' | 'marginal' | 'fail' | 'not_assessed' {
  const regular = rows.filter((row) => row['singular'] !== true);
  if (rows.some((row) => row.status === 'NOT_ASSESSED')) return 'not_assessed';
  if (regular.some((row) => row.status === 'FAIL')) return 'fail';
  return regular.some((row) => row.status === 'MARGINAL') ? 'marginal' : 'pass';
}
