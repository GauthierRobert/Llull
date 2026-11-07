/** The pure half of the run_convergence_study transport (PHY-00 §5.5): the level plan and the study params built from the level runs. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, MeshControls } from '@core/model/analysis';
import type { StudyQuantity } from '@core/model/convergenceStudy';
import type { CadDocument } from '@core/model/types';
import { representativeSpacing } from '@lib/convergence';
import { resultsSummary } from '../results/summary';
import { caseOf } from '../shared/access';
import { isQuantityProblem, meshMeasure, quantityValue, studyQuantityShape, toStudyQuantity, type QuantityProblem } from './studyQuantity';
import { levelDocument } from './studyState';

/** Named guard: largest level mesh the study runs (tetrahedra); a finer level is refused with VNV_LEVEL_TOO_LARGE. */
export const STUDY_MAX_ELEMENTS = 2_000_000;
/** Named default of the transport: the size ratio between consecutive levels (grid doubling, the NPARC example); an llull choice. */
const STUDY_DEFAULT_RATIO = 2;
const STUDY_DEFAULT_LEVELS = 3;
const STUDY_MAX_LEVELS = 6;

export interface StudyRefusal {
  readonly code: string;
  readonly message: string;
}

export const isStudyRefusal = (value: object): value is StudyRefusal => 'code' in value && 'message' in value;

export interface StudyPlan {
  readonly quantity: StudyQuantity;
  readonly ratio: number;
  /** Finest first (index 0); each carries the controls the level is meshed with. */
  readonly levels: readonly { readonly index: number; readonly controls: MeshControls }[];
}

export interface StudyOptions {
  /** The flat quantity object ({ kind, probeId?, loadCase?, field?, mode? }), validated here. */
  readonly quantity: unknown;
  readonly levels?: number | undefined;
  readonly ratio?: number | undefined;
  /** globalSize of the finest level, document units; default the case's own. */
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

/**
 * The levels of a study of `analysisId`: size_k = finest x ratio^k, k = 0 finest.
 * @invariant the case's own mesh controls are untouched (levels are in-memory copies)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; levels outside 3..6, ratio <= 1.1 or a non-positive finest size -> VNV_PARAM_INVALID /
 *   VNV_RATIO_TOO_SMALL; a quantity that does not fit its kind -> VNV_PARAM_INVALID; shell / plane-stress parts -> VNV_CASE_UNSUPPORTED
 */
export function planStudy(doc: CadDocument, analysisId: string, options: StudyOptions): StudyPlan | StudyRefusal {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  const parsed = studyQuantityShape.safeParse(options.quantity);
  if (!parsed.success) return { code: 'VNV_PARAM_INVALID', message: `quantity: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const quantity = toStudyQuantity(parsed.data);
  if (isQuantityProblem(quantity)) return quantity;
  const levels = options.levels ?? STUDY_DEFAULT_LEVELS;
  if (!Number.isInteger(levels) || levels < STUDY_DEFAULT_LEVELS || levels > STUDY_MAX_LEVELS)
    return { code: 'VNV_PARAM_INVALID', message: `levels must be an integer from ${STUDY_DEFAULT_LEVELS} to ${STUDY_MAX_LEVELS}` };
  const ratio = options.ratio ?? STUDY_DEFAULT_RATIO;
  if (!(ratio > 1.1)) return { code: 'VNV_RATIO_TOO_SMALL', message: `ratio ${ratio} must be above 1.1 (recommended >= 1.3)` };
  const finest = options.finest ?? analysisCase.mesh.globalSize;
  if (!(finest > 0) || !Number.isFinite(finest)) return { code: 'VNV_PARAM_INVALID', message: 'finest must be a finite size > 0' };
  const solid = Object.values(analysisCase.parts).every((idealization) => idealization.kind === 'solid');
  if (!solid || Object.keys(analysisCase.parts).length === 0)
    return {
      code: 'VNV_CASE_UNSUPPORTED',
      message: 'M3 studies cover analyses whose parts are all solid (tetrahedral); shell and plane-stress parts are not studied yet',
    };
  return {
    quantity,
    ratio,
    levels: Array.from({ length: levels }, (_, index) => ({ index, controls: scaledControls(analysisCase.mesh, finest * ratio ** index) })),
  };
}

/** The document as the level `controls` mesh it: what the mesh and solve transports read for that level. */
export function levelDocumentOf(doc: CadDocument, analysisId: string, controls: MeshControls): CadDocument {
  const analysisCase: AnalysisCase | undefined = caseOf(doc, analysisId);
  return analysisCase === undefined ? doc : levelDocument(doc, analysisCase, controls);
}

export interface LevelRun {
  readonly index: number;
  readonly controls: MeshControls;
  readonly mesh: FeMeshArtifact;
  readonly meshHash: string;
  readonly results: FeResultsArtifact;
  readonly resultsHash: string;
}

/**
 * The `study` params of record_convergence_study from the finished level runs (finest first): each level's tetrahedron count, spacing
 * (volume of the FINEST mesh / elements)^(1/3) and value, read from the artifacts with the same code the record command re-derives them with.
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
    const levelDoc = levelDocumentOf(doc, analysisId, run.controls);
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
      h: representativeSpacing(measure.value, own.elements, measure.dimension),
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
    measure: { value: measure.value, dimension: measure.dimension },
    levels,
    ...(extra.formalOrder !== undefined ? { formalOrder: extra.formalOrder } : {}),
    ...(extra.safetyFactor !== undefined ? { safetyFactor: extra.safetyFactor } : {}),
  };
}
