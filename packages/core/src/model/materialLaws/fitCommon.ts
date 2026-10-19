/** Shared shape of a non-linear fit result (PHY-02 §5.7, V2). */

import type { MaterialValidRange } from '../materialModel';
import type { FitSummary } from './fit';
import type { ConvergenceReport, SearchSuccess } from './fitSearch';
import { isLawFailure, type LawFailure } from './resolve';

export interface NonlinearBase {
  /** The fitted law in `add_material_model` input form. */
  readonly law: Record<string, unknown>;
  readonly summary: FitSummary;
  readonly convergence: ConvergenceReport;
  /** Range of the data in the variable of the law (stretch, equivalent plastic strain, time, …). */
  readonly range: MaterialValidRange;
  readonly perTest: readonly object[];
  /** Notes about the result (e.g. a Prony term with no weight), as { code, message }. */
  readonly notes?: readonly { readonly code: string; readonly message: string }[];
}

/** Build the fit from a successful search, or pass the failure through. */
export function fitFailureOr<T>(
  outcome: SearchSuccess | LawFailure,
  build: (values: readonly number[], report: ConvergenceReport) => T | LawFailure,
): T | LawFailure {
  return isLawFailure(outcome) ? outcome : build(outcome.values, outcome.report);
}
