/** The pure half of the run_convergence_study transport (PHY-00 §5.5): the level plan and the study params built from the level runs. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, MeshControls } from '@core/model/analysis';
import type { StudyQuantity, StudyRefinement } from '@core/model/convergenceStudy';
import type { CadDocument } from '@core/model/types';
import { representativeSpacing } from '@lib/convergence';
import { resultsSummary } from '../results/summary';
import { caseOf } from '../shared/access';
import { isQuantityProblem, meshMeasure, quantityValue, studyQuantityShape, toStudyQuantity, type QuantityProblem } from './studyQuantity';
import { REFINEMENTS } from './studyKinds';
import { levelDocument, type LevelSpec } from './studyState';

/** Named guard: largest level mesh the study runs (tetrahedra); a finer level is refused with VNV_LEVEL_TOO_LARGE. */
export const STUDY_MAX_ELEMENTS = 2_000_000;
/** Named default of the transport: the size ratio between consecutive levels (grid doubling, the NPARC example); an llull choice. */
const STUDY_DEFAULT_RATIO = 2;
const STUDY_DEFAULT_LEVELS = 3;
const STUDY_DEFAULT_REFINEMENT: StudyRefinement = 'h';
/** Nominal ratio of the two orders of an order study (order 2 over order 1 in element size terms: 1 / order). */
const STUDY_ORDER_RATIO = 2;
const STUDY_MAX_LEVELS = 6;
/** Named default of a time-step study: the coarsest level takes this many increments (the finest ratio^(levels-1) times more); an llull choice. */
const STUDY_DT_COARSEST_INCREMENTS = 8;
/** An order study has exactly the two orders CalculiX offers. */
const STUDY_ORDER_LEVELS = 2;

export interface StudyRefusal {
  readonly code: string;
  readonly message: string;
}

export const isStudyRefusal = (value: object): value is StudyRefusal => 'code' in value && 'message' in value;

interface PlannedLevel extends LevelSpec {
  readonly index: number;
}

export interface StudyPlan {
  readonly refinement: StudyRefinement;
  readonly quantity: StudyQuantity;
  readonly ratio: number;
  /** Finest first (index 0); each carries the controls the level is meshed with and its size `h` (see StudyLevel.h: for kind h the planned globalSize, informative). */
  readonly levels: readonly PlannedLevel[];
}

export interface StudyOptions {
  /** The flat quantity object ({ kind, probeId?, loadCase?, field?, mode? }), validated here. */
  readonly quantity: unknown;
  /** What to refine: the mesh size (default), the transient time step, or the element order. */
  readonly refinement?: string | undefined;
  readonly levels?: number | undefined;
  readonly ratio?: number | undefined;
  /** Size of the finest level: globalSize in document units (h, default the case's own) or the increment in seconds (dt, default endTime / (8 x ratio^(levels-1))); not used by p. */
  readonly finest?: number | undefined;
}

/** The controls of a level of global size `size`: the case's controls with `minSize` and every refinement size scaled by size / case globalSize. */
function scaledControls(base: MeshControls, size: number): MeshControls {
  const scale = size / base.globalSize;
  return {
    ...base,
    globalSize: size,
    ...(base.minSize !== undefined ? { minSize: base.minSize * scale } : {}),
    refinements: base.refinements.map((refinement) => ({ ...refinement, size: refinement.size * scale })),
  };
}

/** The time-step levels (finest first) of a heat_transient case, or why it cannot be studied: each increment must divide the end time. */
function timeStepLevels(
  analysisCase: AnalysisCase,
  levels: number,
  ratio: number,
  finestGiven: number | undefined,
): PlannedLevel[] | StudyRefusal {
  const end = analysisCase.thermal?.step.endTimeS;
  if (analysisCase.type !== 'heat_transient' || end === undefined || !(end > 0))
    return {
      code: 'VNV_CASE_UNSUPPORTED',
      message:
        'time-step studies cover heat_transient analyses with an end time (set_thermal_step endTimeS); the structural dynamics analyses (frequency response, random response, explicit) have no fixed transient step run by these transports',
    };
  const finest = finestGiven ?? end / (STUDY_DT_COARSEST_INCREMENTS * ratio ** (levels - 1));
  if (!(finest > 0) || !Number.isFinite(finest))
    return { code: 'VNV_PARAM_INVALID', message: 'finest must be a finite increment > 0 seconds' };
  const sizes = Array.from({ length: levels }, (_, index) => finest * ratio ** index);
  const bad = sizes.find((size) => Math.abs(end / size - Math.round(end / size)) > 1e-9 * Math.max(1, end / size) || size > end);
  if (bad !== undefined)
    return {
      code: 'VNV_PARAM_INVALID',
      message: `the end time ${end} s is not a whole number of increments of ${bad} s: choose finest and ratio so that every level's increment divides the end time`,
    };
  return sizes.map((size, index) => ({ index, controls: analysisCase.mesh, h: size }));
}

/**
 * The levels of a study of `analysisId`: size_k = finest x ratio^k, k = 0 finest (kind h: the mesh size; dt: the transient increment, seconds); kind p
 * has exactly two levels, order 2 then order 1 at the case's mesh size.
 * @invariant the case's own mesh controls and step are untouched (levels are in-memory copies); refinement kinds are never mixed
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; levels outside 3..6 (p: not 2), ratio <= 1.1 or a non-positive finest size -> VNV_PARAM_INVALID /
 *   VNV_RATIO_TOO_SMALL; a quantity that does not fit its kind -> VNV_PARAM_INVALID; shell / plane-stress parts, or a dt study of a case that is not
 *   a heat_transient with an end time -> VNV_CASE_UNSUPPORTED
 */
export function planStudy(doc: CadDocument, analysisId: string, options: StudyOptions): StudyPlan | StudyRefusal {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  const parsed = studyQuantityShape.safeParse(options.quantity);
  if (!parsed.success) return { code: 'VNV_PARAM_INVALID', message: `quantity: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const quantity = toStudyQuantity(parsed.data);
  if (isQuantityProblem(quantity)) return quantity;
  const asked = options.refinement ?? STUDY_DEFAULT_REFINEMENT;
  const refinement = REFINEMENTS.find((kind) => kind === asked);
  if (refinement === undefined)
    return { code: 'VNV_PARAM_INVALID', message: `refinement must be one of ${REFINEMENTS.join(', ')}, not '${asked}'` };
  const order = refinement === 'p';
  const levels = options.levels ?? (order ? STUDY_ORDER_LEVELS : STUDY_DEFAULT_LEVELS);
  const [lowest, highest] = order ? [STUDY_ORDER_LEVELS, STUDY_ORDER_LEVELS] : [STUDY_DEFAULT_LEVELS, STUDY_MAX_LEVELS];
  if (!Number.isInteger(levels) || levels < lowest || levels > highest)
    return {
      code: 'VNV_PARAM_INVALID',
      message: order
        ? 'an element-order study has exactly 2 levels (order 2 and order 1)'
        : `levels must be an integer from ${lowest} to ${highest}`,
    };
  const ratio = options.ratio ?? STUDY_DEFAULT_RATIO;
  if (!order && !(ratio > 1.1)) return { code: 'VNV_RATIO_TOO_SMALL', message: `ratio ${ratio} must be above 1.1 (recommended >= 1.3)` };
  const finest = options.finest ?? analysisCase.mesh.globalSize;
  if (refinement === 'h' && (!(finest > 0) || !Number.isFinite(finest)))
    return { code: 'VNV_PARAM_INVALID', message: 'finest must be a finite size > 0' };
  const solid = Object.values(analysisCase.parts).every((idealization) => idealization.kind === 'solid');
  if (!solid || Object.keys(analysisCase.parts).length === 0)
    return {
      code: 'VNV_CASE_UNSUPPORTED',
      message: 'studies cover analyses whose parts are all solid (tetrahedral); shell and plane-stress parts are not studied yet',
    };
  if (refinement === 'dt') {
    const planned = timeStepLevels(analysisCase, levels, ratio, options.finest);
    return isStudyRefusal(planned) ? planned : { refinement, quantity, ratio, levels: planned };
  }
  if (refinement === 'p')
    return {
      refinement,
      quantity,
      ratio: STUDY_ORDER_RATIO,
      levels: ([2, 1] as const).map((orderOf, index) => ({ index, controls: { ...analysisCase.mesh, order: orderOf }, h: 1 / orderOf })),
    };
  return {
    refinement,
    quantity,
    ratio,
    levels: Array.from({ length: levels }, (_, index) => {
      const size = finest * ratio ** index;
      return { index, controls: scaledControls(analysisCase.mesh, size), h: size };
    }),
  };
}

/** The document as the level `level` of a `refinement` study runs it: what the mesh and solve transports read for that level. */
export function levelDocumentOf(doc: CadDocument, analysisId: string, refinement: StudyRefinement, level: LevelSpec): CadDocument {
  const analysisCase: AnalysisCase | undefined = caseOf(doc, analysisId);
  return analysisCase === undefined ? doc : levelDocument(doc, analysisCase, refinement, level);
}

export interface LevelRun extends LevelSpec {
  readonly index: number;
  readonly mesh: FeMeshArtifact;
  readonly meshHash: string;
  readonly results: FeResultsArtifact;
  readonly resultsHash: string;
}

/**
 * The `study` params of record_convergence_study from the finished level runs (finest first): each level's tetrahedron count, size (h: spacing
 * (volume of the FINEST mesh / elements)^(1/3); dt: the increment; p: 1 / order) and value, read from the artifacts with the same code the record command re-derives them with.
 * @failure no tetrahedra -> VNV_CASE_UNSUPPORTED; a quantity the results do not hold -> VNV_QUANTITY_UNAVAILABLE
 */
export function studyParams(
  doc: CadDocument,
  analysisId: string,
  plan: StudyPlan,
  runs: readonly LevelRun[],
  extra: { readonly formalOrder?: number | undefined; readonly safetyFactor?: number | undefined },
): Record<string, unknown> | StudyRefusal | QuantityProblem {
  const finest = runs[0];
  if (finest === undefined) return { code: 'VNV_PARAM_INVALID', message: 'no level ran' };
  const measure = meshMeasure(finest.mesh);
  if (isQuantityProblem(measure)) return measure;
  let unit: string | undefined;
  const levels: Record<string, unknown>[] = [];
  for (const run of runs) {
    const levelDoc = levelDocumentOf(doc, analysisId, plan.refinement, run);
    const levelCase = caseOf(levelDoc, analysisId);
    if (levelCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
    const own = meshMeasure(run.mesh);
    if (isQuantityProblem(own)) return own;
    const reading = quantityValue(
      levelDoc,
      levelCase,
      run.mesh,
      run.results,
      resultsSummary(levelDoc, analysisId, run.mesh, run.results, run.resultsHash),
      plan.quantity,
    );
    if (isQuantityProblem(reading)) return { code: reading.code, message: `level ${run.index}: ${reading.message}` };
    unit ??= reading.unit;
    levels.push({
      controls: run.controls,
      elements: own.elements,
      h: plan.refinement === 'h' ? representativeSpacing(measure.value, own.elements, measure.dimension) : run.h,
      value: reading.value,
      meshHash: run.meshHash,
      resultsHash: run.resultsHash,
      inputHash: run.results.inputHash,
      solver: run.results.solver,
      solverVersion: run.results.solverVersion,
      mesher: run.mesh.mesher,
      mesherVersion: run.mesh.mesherVersion,
    });
  }
  return {
    quantity: plan.quantity,
    unit,
    ratio: plan.ratio,
    refinement: plan.refinement,
    ...(plan.refinement === 'h' ? { measure: { value: measure.value, dimension: measure.dimension } } : {}),
    levels,
    ...(extra.formalOrder !== undefined ? { formalOrder: extra.formalOrder } : {}),
    ...(extra.safetyFactor !== undefined ? { safetyFactor: extra.safetyFactor } : {}),
  };
}
