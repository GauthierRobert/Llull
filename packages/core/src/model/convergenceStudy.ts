/**
 * Convergence studies (PHY-00 VNV-M3): recorded on `AnalysisCase.studies`. A study holds only what was MEASURED (one value per mesh level, each bound to
 * the mesh / results artifacts and the input hash of its level); the report (observed order, extrapolation, GCI) and the staleness are always
 * recomputed from it, never stored.
 * @invariant JSON-serialisable and finite; levels are finest first (index 0); one study follows ONE refinement kind (never mixed): `h` mesh size (level `h`
 * is the representative spacing, analysis length unit), `dt` transient time step (level `h` is the fixed increment in seconds; the mesh is the case's own),
 * `p` element order (two levels: order 2 then order 1 on the same mesh size; level `h` is 1 / order, a nominal size)
 */

import type { NamedValue } from './topology';

/** What a study refines: the mesh size, the transient time step or the element order. */
export type StudyRefinement = 'h' | 'dt' | 'p';

/** The scalar result a study follows across refinement levels. */
export type StudyQuantity =
  | { readonly kind: 'probe'; readonly probeId: string; readonly loadCase?: string }
  | { readonly kind: 'field_max'; readonly field: 'von_mises' | 'u_mag'; readonly loadCase: string }
  | { readonly kind: 'frequency'; readonly mode: number }
  | { readonly kind: 'buckling_factor'; readonly mode: number };

/** `C` is the mesh-controls type (`MeshControls` of analysis.ts, a type parameter so this module does not import it back). */
export interface StudyLevel<C> {
  /** 0 = finest. */
  readonly index: number;
  /** The mesh controls this level was meshed with (kind h: the case's controls with `globalSize` and refinement sizes scaled; dt: the case's own; p: the case's with `order` set). */
  readonly controls: C;
  readonly elements: number;
  /** The level's refinement size: h = (measure / elements)^(1/dimension) in the analysis length unit (kind h), the time increment in seconds (dt), 1 / order (p). */
  readonly h: number;
  /** The quantity at this level, in the study unit. */
  readonly value: number;
  readonly meshHash: string;
  readonly resultsHash: string;
  /** Full input hash (05 TR-FEA-06) of the case with `controls` at the time of the run: staleness compares it with the current one. */
  readonly inputHash: string;
  readonly solver: string;
  readonly solverVersion: string;
  readonly mesher: string;
  readonly mesherVersion: string;
}

/** A human acceptance of a non-asymptotic or non-monotone study (signed through the signing port). */
export interface StudyException {
  readonly code: string;
  readonly justification: string;
  readonly signer: string;
  readonly signatureId: string;
  readonly signature: unknown;
  /** Result hashes of the levels the acceptance covers (it ends when a level changes). */
  readonly levelHashes: readonly string[];
  readonly documentUid: string;
}

/** An acceptance kept in `AnalysisModel.exceptionLedger` across replay (the recorded step carries no signature): the exception plus where it belongs. */
export interface StudyExceptionRecord extends StudyException {
  readonly analysisId: string;
  readonly studyId: string;
}

export interface ConvergenceStudy<C> {
  /** `cs-<step>.<k>` (L8). */
  readonly id: string;
  readonly analysisId: string;
  readonly quantity: StudyQuantity;
  readonly unit: string;
  readonly refinement: StudyRefinement;
  /** Nominal refinement ratio between consecutive levels (informative; the arithmetic uses the measured sizes). */
  readonly ratio: number;
  /** Analysed domain measure behind every `h` (kind h only; absent for dt and p): volume (3) in the analysis length unit^dimension. */
  readonly measure?: { readonly value: number; readonly dimension: 1 | 2 | 3 };
  /** 3 to 6 levels (kinds h, dt) or exactly 2 (kind p), finest first. */
  readonly levels: readonly StudyLevel<C>[];
  readonly formalOrder?: NamedValue;
  readonly safetyFactor: NamedValue;
  /** `false` = recorded WITHOUT its artifacts (replay on a machine lacking the store): the numbers are a claim, never trusted. */
  readonly verified?: false;
  readonly exception?: StudyException;
}

/** The study fields of an analysis case (`record_convergence_study`); both absent until the first study. */
export interface CaseStudies<C> {
  readonly studies?: Readonly<Record<string, ConvergenceStudy<C>>>;
  readonly studyOrder?: readonly string[];
}
