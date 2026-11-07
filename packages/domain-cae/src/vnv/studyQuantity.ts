/** The scalar a convergence study follows: its params schema, and its reading (value, unit) from verified mesh / results artifacts. */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact, ResultsSummary } from '@core/model/analysis';
import type { StudyQuantity, StudyRefinement } from '@core/model/convergenceStudy';
import type { NamedValue } from '@core/model/topology';
import type { CadDocument } from '@core/model/types';
import { z } from '@core/commands/schema';
import { buildDeckContext } from '../decks/context';
import { lengthUnitName, stressUnitName } from '../decks/units';
import { evaluateProbes } from '../results/probes';
import { indexMesh, partVolumes } from '../thermal/meshGeometry';

/** Flat params form of a StudyQuantity (one object, per-kind fields), validated by `toStudyQuantity`. */
export const studyQuantityShape = z
  .object({
    kind: z.enum(['probe', 'field_max', 'frequency', 'buckling_factor']).describe('Which result to follow across the mesh levels.'),
    probeId: z.string().optional().describe('kind probe: id of the result probe (add_result_probe) of the analysis.'),
    loadCase: z
      .string()
      .optional()
      .describe(
        'kind field_max: the load case name (required); kind probe: the load case to read (required when the analysis has several).',
      ),
    field: z.enum(['von_mises', 'u_mag']).optional().describe('kind field_max: the field whose maximum over the model is followed.'),
    mode: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('kind frequency (modal analysis) or buckling_factor (buckling analysis): 1-based mode.'),
  })
  .describe(
    'The quantity followed: probe { probeId, loadCase? }, field_max { field, loadCase }, frequency { mode } or buckling_factor { mode }. ' +
      'A maximum over a field of a model with singular spots (point loads, sharp corners) does not converge: prefer a probe away from them.',
  );

export type StudyQuantityInput = z.output<typeof studyQuantityShape>;

export interface QuantityProblem {
  readonly code: 'VNV_QUANTITY_UNAVAILABLE' | 'VNV_CASE_UNSUPPORTED' | 'VNV_PARAM_INVALID';
  readonly message: string;
}

export const isQuantityProblem = (value: object): value is QuantityProblem => 'code' in value && 'message' in value;

const invalid = (message: string): QuantityProblem => ({ code: 'VNV_PARAM_INVALID', message });

/** The typed quantity of a params object, or why its fields do not fit its kind. */
export function toStudyQuantity(input: StudyQuantityInput): StudyQuantity | QuantityProblem {
  switch (input.kind) {
    case 'probe':
      return input.probeId === undefined
        ? invalid("quantity.kind 'probe' needs probeId")
        : { kind: 'probe', probeId: input.probeId, ...(input.loadCase !== undefined ? { loadCase: input.loadCase } : {}) };
    case 'field_max':
      return input.field === undefined || input.loadCase === undefined
        ? invalid("quantity.kind 'field_max' needs field and loadCase")
        : { kind: 'field_max', field: input.field, loadCase: input.loadCase };
    default:
      return input.mode === undefined ? invalid(`quantity.kind '${input.kind}' needs mode`) : { kind: input.kind, mode: input.mode };
  }
}

export interface Reading {
  readonly value: number;
  readonly unit: string;
}

const unavailable = (message: string): QuantityProblem => ({ code: 'VNV_QUANTITY_UNAVAILABLE', message });

const finite = (value: number | null | undefined, what: string): Reading['value'] | QuantityProblem =>
  value !== null && value !== undefined && Number.isFinite(value) ? value : unavailable(`${what} has no finite value in the results`);

/**
 * The value and unit of `quantity` in verified results. Not a hostile-input reader: it reads typed, hash-verified artifacts, never external text or bytes.
 * @invariant pure; the unit is the analysis unit of the quantity (stress, length, 'Hz', '1' for a buckling factor); a probe is read at the node
 *   the results artifact holds (05 evaluateProbes)
 * @failure unknown probe / load case / mode, ambiguous probe load case, non-finite value -> VNV_QUANTITY_UNAVAILABLE
 */
export function quantityValue(
  doc: CadDocument,
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  summary: ResultsSummary,
  quantity: StudyQuantity,
): Reading | QuantityProblem {
  if (quantity.kind === 'frequency' || quantity.kind === 'buckling_factor') {
    const column = quantity.kind === 'frequency' ? summary.frequenciesHz : summary.bucklingFactors;
    if (column === undefined)
      return unavailable(
        `the results hold no ${quantity.kind === 'frequency' ? 'frequencies (modal analysis)' : 'buckling factors (buckling analysis)'}`,
      );
    const value = finite(column[quantity.mode - 1], `mode ${quantity.mode}`);
    return typeof value === 'number' ? { value, unit: quantity.kind === 'frequency' ? 'Hz' : '1' } : value;
  }
  if (quantity.kind === 'field_max') {
    const found = summary.loadCases.find((entry) => entry.name === quantity.loadCase);
    if (found === undefined)
      return unavailable(`no load case '${quantity.loadCase}' in the results (${summary.loadCases.map((entry) => entry.name).join(', ')})`);
    const value = finite(
      quantity.field === 'von_mises' ? found.maxVonMises.value : found.maxDisplacement.value,
      `${quantity.field} of ${quantity.loadCase}`,
    );
    return typeof value === 'number'
      ? { value, unit: quantity.field === 'von_mises' ? stressUnitName(summary.units) : lengthUnitName(summary.units) }
      : value;
  }
  const probe = Object.hasOwn(analysis.probes, quantity.probeId) ? analysis.probes[quantity.probeId] : undefined;
  if (probe === undefined) return unavailable(`no probe '${quantity.probeId}' in analysis '${analysis.id}'`);
  const deck = buildDeckContext(doc, analysis.id, mesh);
  if (deck === null) return unavailable(`no analysis '${analysis.id}' in the document`);
  const { lengthToAnalysis } = deck;
  const reading = evaluateProbes(analysis, mesh, results, lengthToAnalysis).find((entry) => entry.probeId === quantity.probeId);
  if (reading === undefined) return unavailable(`probe '${quantity.probeId}' cannot be evaluated for a ${analysis.type} analysis`);
  if (analysis.type === 'heat_transient') return transientEnd(analysis, probe.quantity, reading);
  const wanted = reading.values.filter((entry) => quantity.loadCase === undefined || entry.loadCase === quantity.loadCase);
  if (wanted.length !== 1)
    return unavailable(
      wanted.length === 0
        ? `probe '${quantity.probeId}' has no value for load case '${quantity.loadCase ?? ''}'`
        : `probe '${quantity.probeId}' has ${wanted.length} values: name the load case`,
    );
  const value = finite(wanted[0]?.value, `probe '${quantity.probeId}'`);
  return typeof value === 'number' ? { value, unit: reading.unit } : value;
}

/** A transient probe is followed at the END of the step: the last written result set, which must reach the case's end time. */
function transientEnd(
  analysis: AnalysisCase,
  probeQuantity: string,
  reading: {
    readonly probeId: string;
    readonly unit: string;
    readonly values: readonly { readonly time: number; readonly value: number | null }[];
  },
): Reading | QuantityProblem {
  const end = analysis.thermal?.step.endTimeS;
  const last = reading.values.reduce<{ readonly time: number; readonly value: number | null } | undefined>(
    (latest, entry) => (latest === undefined || entry.time > latest.time ? entry : latest),
    undefined,
  );
  if (end === undefined || last === undefined || !(Math.abs(last.time - end) <= 1e-6 * end))
    return unavailable(
      `the results of '${analysis.id}' do not reach the end time (${last === undefined ? 'no result set' : `last time ${last.time} s`}, end ${end ?? 'unset'} s)`,
    );
  const value = finite(last.value, `probe '${reading.probeId}' (${probeQuantity}) at ${end} s`);
  return typeof value === 'number' ? { value, unit: reading.unit } : value;
}

export interface Measure {
  readonly value: number;
  readonly dimension: 3;
  /** Number of tetrahedra (C3D4 / C3D10) of the mesh. */
  readonly elements: number;
}

/**
 * The volume (analysis length unit cubed) and tetrahedron count of a mesh: the base of h = (volume / elements)^(1/3).
 * @failure no tetrahedron, or zero volume -> VNV_CASE_UNSUPPORTED
 */
export function meshMeasure(mesh: FeMeshArtifact): Measure | QuantityProblem {
  const index = indexMesh(mesh);
  let volume = 0;
  for (const part of partVolumes(index).values()) volume += part;
  if (index.elements.size === 0 || !(volume > 0))
    return {
      code: 'VNV_CASE_UNSUPPORTED',
      message: 'the mesh has no solid tetrahedra (shell and plane-stress meshes are not studied yet)',
    };
  return { value: volume, dimension: 3, elements: index.elements.size };
}

const TIME_INTEGRATION =
  'backward-Euler time integration of CalculiX heat transfer (llull assumption; reviewer-confirmable, PHY-00 TECHNICAL_SPEC 11)';
const TEXTBOOK = 'a priori FE error estimates (textbook; reviewer-confirmable, PHY-00 TECHNICAL_SPEC 5.4)';

/**
 * The named default formal order of the quantity for `order` 1 (linear) or 2 (quadratic) tetrahedra: displacement 2 / 3, stress 1 / 2, and the
 * eigenvalue quantities (frequency, buckling factor) twice the energy rate (stress rate) 2 / 4; a time-step study 1 (backward Euler), an order study none.
 * Undefined for quantities the table does not cover.
 */
export function formalOrderDefault(
  analysis: AnalysisCase,
  quantity: StudyQuantity,
  order: 1 | 2,
  refinement: StudyRefinement,
): NamedValue | undefined {
  if (refinement === 'dt') return { value: 1, source: TIME_INTEGRATION, defaulted: true };
  if (refinement === 'p') return undefined;
  const rates = { displacement: [2, 3], stress: [1, 2], eigen: [2, 4] } as const;
  const probe =
    quantity.kind === 'probe' && Object.hasOwn(analysis.probes, quantity.probeId) ? analysis.probes[quantity.probeId] : undefined;
  let family: keyof typeof rates | undefined;
  if (quantity.kind === 'field_max') family = quantity.field === 'u_mag' ? 'displacement' : 'stress';
  else if (quantity.kind === 'frequency' || quantity.kind === 'buckling_factor') family = 'eigen';
  else if (probe !== undefined)
    family = probe.quantity.startsWith('u_')
      ? 'displacement'
      : probe.quantity === 'von_mises' || probe.quantity.startsWith('s_')
        ? 'stress'
        : undefined;
  return family === undefined ? undefined : { value: order === 1 ? rates[family][0] : rates[family][1], source: TEXTBOOK, defaulted: true };
}
