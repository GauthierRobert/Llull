/** Types and formatting shared by the convergence-analysis branches (Celik triplet, least squares, order pair). */

/** One finding of an analysis (codes of PHY-00 §7.1 and the V1 additions). */
export interface Finding {
  readonly code: string;
  readonly severity: 'warning' | 'fail';
  readonly message: string;
  readonly remediation: string;
}

/** A fraction as text: 0.0123 -> "1.23 %". */
export const percent = (fraction: number): string => `${(fraction * 100).toPrecision(3)} %`;

/** Method name of the least-squares branch (named in every report that uses it). */
export const LSQ_METHOD = 'eca-hoekstra-lsq';

/** The fit and its uncertainty, as reported (all in the quantity unit unless named a fraction). */
export interface LeastSquaresSummary {
  readonly method: typeof LSQ_METHOD;
  readonly p: number;
  readonly f0: number;
  readonly alpha: number;
  readonly standardError?: { readonly p: number; readonly f0: number; readonly alpha: number };
  readonly residual: { readonly rss: number; readonly rms: number; readonly standardDeviation: number; readonly degreesOfFreedom: number };
  /** Fs |f1 - f0| + the standard deviation of the fit; `relative` is a FRACTION of the finest value (absent when it is 0). */
  readonly uncertainty: { readonly absolute: number; readonly relative?: number };
}

/** What the pair of orders shows: the quadratic (finer) and linear (coarser) values and their difference. */
export interface OrderPairSummary {
  readonly quadratic: number;
  readonly linear: number;
  readonly difference: { readonly absolute: number; readonly relative?: number };
}
