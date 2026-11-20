/** 14 FLL: which analyses apply an inertial (flight) load: only a static CalculiX deck does; check_analysis and the deck share this refusal. */

import type { AnalysisCase } from '@core/model/analysis';

export interface InertialUnsupported {
  readonly code: 'FLL_INERTIAL_UNSUPPORTED';
  readonly message: string;
  readonly ids: readonly string[];
}

/**
 * FLL_INERTIAL_UNSUPPORTED when a non-static analysis (modal, buckling, nonlinear_static, ...) carries an inertial load, else null.
 * @invariant null for a static analysis and for any analysis without an inertial load
 */
export function inertialUnsupported(analysis: AnalysisCase): InertialUnsupported | null {
  if (analysis.type === 'static') return null;
  const ids = analysis.loadOrder
    .flatMap((id) => analysis.loads[id] ?? [])
    .filter((load) => load.kind === 'inertial')
    .map((load) => load.id);
  if (ids.length === 0) return null;
  return {
    code: 'FLL_INERTIAL_UNSUPPORTED',
    message: `inertial load(s) ${ids.map((id) => `'${id}'`).join(', ')} in a ${analysis.type} analysis: only static decks apply them`,
    ids,
  };
}
