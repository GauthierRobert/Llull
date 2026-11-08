/** PHY-05 nonlinear static data types that are not set-up bags of `AnalysisCase`: the imperfection record and the solved summary. */

import type { Vec3 } from './vectors';

/**
 * PHY-05 TR-NLS-30 geometric imperfection of a nonlinear_static case (`NonlinearSettings.imperfections`): deck node coordinates perturbed by
 * sum(amplitude_i x phi_i / max|phi_i|) over buckling mode shapes, PINNED by results hash (the deck reads exactly that artifact, whatever
 * happens to the source case later).
 */
export interface Imperfection {
  readonly id: string;
  /** The buckling case the modes were taken from (provenance; the data is the artifact `sourceResultsHash`). */
  readonly fromAnalysisId: string;
  readonly sourceResultsHash: string;
  /** mode: 1-based buckling mode; amplitude: signed largest nodal offset of that mode, DOCUMENT length units; factor: its buckling factor. */
  readonly modes: readonly { readonly mode: number; readonly amplitude: number; readonly factor: number }[];
  /** Who or which rule set the amplitude (AF-31: mandatory, no default). */
  readonly amplitudeSource: string;
}

/** `ResultsSummary.nonlinear` of a solved nonlinear_static case. */
export interface NonlinearResultsSummary {
  readonly nlgeom: boolean;
  /** Every analysis step reached its end time (a run that stops early is a solver failure and is never recorded). */
  readonly completed: boolean;
  readonly steps: ReadonlyArray<{
    stepId: string;
    increments: number;
    cutbacks: number;
    iterations: number;
    lastLoadFactor: number;
    completed: boolean;
  }>;
  readonly curves: ReadonlyArray<{
    probeId: string;
    name: string;
    points: number;
    peakLoad: number;
    dispRange: readonly [number, number];
    curveHash: string;
  }>;
  readonly maxPeeq?: { value: number; at: Vec3; step: number };
}
