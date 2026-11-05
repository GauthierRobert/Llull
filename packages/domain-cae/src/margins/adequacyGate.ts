/** Mesh-adequacy gate of compute_margins (FR-INT-06, TR-INT-08): rows of an inadequate result are not assessed unless the caller accepts the mesh. */

import type { FeMeshAdequacy } from '@core/model/meshAdequacy';
import { inadequacyReasons } from '../results/adequacy';

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
 * @invariant adequate / marginal results pass through untouched; `accept` restores the numeric rows and is recorded in `overrides`
 */
export function gateRows<R extends GateRow>(rows: readonly R[], adequacy: FeMeshAdequacy, accept: boolean): GatedRows<R> {
  if (adequacy.verdict !== 'inadequate') return { rows, gated: false, overrides: [], reasons: [] };
  const reasons = inadequacyReasons(adequacy);
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

/** `not_assessed` when a row is not assessed, else `fail` / `marginal` / `pass` by the worst regular (non-singular) row. */
export function overallOf(rows: readonly GateRow[]): 'pass' | 'marginal' | 'fail' | 'not_assessed' {
  const regular = rows.filter((row) => row['singular'] !== true);
  if (rows.some((row) => row.status === 'NOT_ASSESSED')) return 'not_assessed';
  if (regular.some((row) => row.status === 'FAIL')) return 'fail';
  return regular.some((row) => row.status === 'MARGINAL') ? 'marginal' : 'pass';
}
