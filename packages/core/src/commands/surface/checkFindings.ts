/** Findings of `check_sweep_loft`: the shared record, remediation table and rounding. */

import { roundSignificant } from '../../lib/significant';

export type Severity = 'fail' | 'warn' | 'info';

export interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly entityId: string;
  readonly at?: number;
  readonly value: number | null;
  readonly limit: number | null;
  readonly unit: string;
  readonly remediation: string;
  readonly message: string;
}

export interface NamedTolerance {
  readonly value: number;
  readonly unit: string;
  readonly defaulted: boolean;
  readonly source: string;
}

export const sig = (value: number): number => roundSignificant(value, 10);

export const REMEDIATION: Readonly<Record<string, string>> = {
  SWG_CHECK_SELF_INTERSECTION_LOCAL:
    'use a smaller section or scale, or a larger bend radius, so that the fold margin stays above the limit',
  SWG_CHECK_FRAME_DEGENERATE: 'rebuild the sweep with orientation minimal, or another direction',
  SWG_CHECK_LAW_INVALID: 'fix the twist / scale / area laws so that they are finite, and scale / area positive',
  SWG_CHECK_SELF_INTERSECTION_GLOBAL: 'use a larger pitch or a smaller section so neighbouring turns do not touch',
  SWG_CHECK_FIT_APPROXIMATION:
    'none for an info finding; a warning means the exact solid is not built (mesh only): loosen fitTolerance or simplify the sweep',
  SWG_CHECK_RAIL_DEVIATION: 'loosen railTolerance / fitTolerance, simplify the rails, or split the path',
  SWG_CHECK_LOFT_TWIST: 'rebuild the loft with alignment auto (or seams) so the section starts line up',
  SWG_CHECK_LOFT_CLOSURE_G1: 'add a section or move the last one so the closed loft returns to the first section tangentially',
  SWG_CHECK_SURFACE_DEGENERATE: 'move the sections or guides so the skin has no pinched or folded interior point',
  SWG_CHECK_SECTION_DEVIATION: 'the skin does not reach a section: rebuild with sections on one basis or a smaller fitTolerance',
};
