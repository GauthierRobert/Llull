/** render_fea_results input phases: the verified result set, the field, the plotted parts, the axis and cut, the deformation. */

import { codedRejection } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { significantNumber } from '@lib/compactNumber';
import { axisFrame, CYLINDRICAL_FIELDS, CYLINDRICAL_QUANTITIES, type AxisFrame, type CylindricalQuantity } from './cylindrical';
import { magnitude } from './fields';
import type { CutPlane } from './fieldFaces';
import { isEigen, isHeat, selectStep, type Selected } from './plotSetup';
import { QUANTITY_FIELDS } from './probes';
import { refuseFe } from '../shared/feCodes';
import type { PROBE_QUANTITIES } from '../commands/probes';

export const PLOT_COMMAND = 'render_fea_results';
/** Auto deformation: the largest displacement is drawn at this fraction of the model size. */
const AUTO_DEFORMATION = 0.08;

export type PlotField = (typeof PROBE_QUANTITIES)[number] | 'mode';

export type Phase<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: CommandResult };
const proceed = <T>(value: T): Phase<T> => ({ ok: true, value });
const stop = (result: CommandResult): Phase<never> => ({ ok: false, result });

/** The params the input phases read. */
export interface InputParams {
  readonly analysisId: string;
  readonly field?: PlotField | undefined;
  readonly mode?: number | undefined;
  readonly loadCase?: string | undefined;
  readonly time?: number | undefined;
  readonly entityIds?: string[] | undefined;
  readonly axisPoint?: [number, number, number] | undefined;
  readonly axisDirection?: [number, number, number] | undefined;
  readonly cut?: { readonly normal: [number, number, number]; readonly offset: number } | undefined;
  readonly deformationScale?: number | undefined;
}

function invalid(doc: CadDocument, message: string, path: string): CommandResult {
  return codedRejection(
    doc,
    PLOT_COMMAND,
    'FEA_PLOT_INVALID',
    message,
    'fix the parameter named in the message and render again',
    [],
    [path],
  );
}

export interface NodeExtreme {
  readonly value: number;
  readonly node: number;
}

export function extremes(
  nodes: Iterable<number>,
  value: (node: number) => number | undefined,
): { min: NodeExtreme | null; max: NodeExtreme | null } {
  let min: NodeExtreme | null = null;
  let max: NodeExtreme | null = null;
  for (const node of nodes) {
    const v = value(node);
    if (v === undefined) continue;
    if (min === null || v < min.value) min = { value: v, node };
    if (max === null || v > max.value) max = { value: v, node };
  }
  return { min, max };
}

export interface Verified {
  readonly analysis: AnalysisCase;
  readonly mesh: FeMeshArtifact;
  readonly selected: Selected;
  readonly quantity: PlotField;
  readonly eigen: boolean;
}

/** The trust verdict fields the plot reads (the verdict itself comes from the caller). */
interface TrustView {
  readonly state: string;
  readonly problem: { readonly message: string } | null;
  readonly meshArtifact: FeMeshArtifact | null;
  readonly resultsArtifact: FeResultsArtifact | null;
}

/** The analysis with its verified mesh and results, the field to colour by, and the result set to plot. */
export function verifiedInputs(doc: CadDocument, params: InputParams, analysis: AnalysisCase, trust: TrustView): Phase<Verified> {
  const { analysisId } = params;
  const { meshArtifact: mesh, resultsArtifact: results } = trust;
  if (mesh === null || results === null)
    return stop(
      refuseFe(
        doc,
        PLOT_COMMAND,
        'FEA_RESULTS_MISSING',
        `analysis '${analysisId}' has no verified results (state ${trust.state}${trust.problem === null ? '' : `: ${trust.problem.message}`})`,
        [analysisId],
      ),
    );
  const eigen = isEigen(analysis);
  if (params.mode !== undefined && !eigen)
    return stop(invalid(doc, `mode applies to modal / buckling analyses only, not ${analysis.type}`, 'mode'));
  const quantity: PlotField = params.field ?? (isHeat(analysis) ? 'temperature' : eigen ? 'mode' : 'von_mises');
  if (quantity === 'mode' && !eigen)
    return stop(invalid(doc, `field 'mode' needs a modal / buckling analysis, not ${analysis.type}`, 'field'));
  const selected = selectStep(analysis, results, params.loadCase, params.time, params.mode);
  if (typeof selected === 'string') return stop(refuseFe(doc, PLOT_COMMAND, 'FEA_RESULTS_MISSING', selected, [analysisId]));
  return proceed({ analysis, mesh, selected, quantity, eigen });
}

type FieldValues = NonNullable<Selected['step']['fields'][string]>['values'];

export interface FieldSource {
  readonly cylindrical: boolean;
  readonly values: FieldValues;
  readonly scalar: (entry: readonly number[], at: Vec3, axis: AxisFrame) => number;
}

/** The results field of `quantity` and its scalar (a mode shape is normalised by its largest displacement). */
export function fieldSource(doc: CadDocument, analysisId: string, quantity: PlotField, selected: Selected): Phase<FieldSource> {
  const cylindrical = (CYLINDRICAL_QUANTITIES as readonly string[]).includes(quantity);
  const { field, scalar: baseScalar } =
    quantity === 'mode'
      ? QUANTITY_FIELDS.u_mag
      : cylindrical
        ? CYLINDRICAL_FIELDS[quantity as CylindricalQuantity]
        : QUANTITY_FIELDS[quantity as keyof typeof QUANTITY_FIELDS];
  const values = selected.step.fields[field]?.values;
  if (values === undefined)
    return stop(
      refuseFe(doc, PLOT_COMMAND, 'FEA_FIELD_MISSING', `the ${selected.label} result set has no ${field} field for ${quantity}`, [
        analysisId,
      ]),
    );
  let peak = quantity === 'mode' ? Number.MIN_VALUE : 1;
  if (quantity === 'mode') for (const entry of Object.values(values)) peak = Math.max(peak, magnitude(entry));
  const scalar: FieldSource['scalar'] = (entry, at, axisFrameValue) => baseScalar(entry, at, axisFrameValue) / peak;
  return proceed({ cylindrical, values, scalar });
}

export interface PartSelection {
  readonly entityIds: ReadonlySet<string> | null;
  readonly partNodes: ReadonlySet<number>;
  readonly boxMin: readonly [number, number, number];
  readonly boxMax: readonly [number, number, number];
  readonly size: number;
}

/** The plotted parts' nodes and bounding box; a part the mesh does not have is refused. */
export function partSelection(
  doc: CadDocument,
  params: InputParams,
  mesh: FeMeshArtifact,
  coordinates: ReadonlyMap<number, Vec3>,
): Phase<PartSelection> {
  const meshEntities = [...new Set(mesh.blocks.map((block) => block.entityId))];
  const unknown = (params.entityIds ?? []).filter((id) => !meshEntities.includes(id));
  if (unknown.length > 0)
    return stop(
      refuseFe(doc, PLOT_COMMAND, 'FEA_PART_INVALID', `no meshed part ${unknown.join(', ')} (meshed parts: ${meshEntities.join(', ')})`, [
        params.analysisId,
      ]),
    );
  const entityIds = params.entityIds === undefined ? null : new Set(params.entityIds);
  const partNodes = new Set<number>();
  for (const block of mesh.blocks)
    if (entityIds === null || entityIds.has(block.entityId))
      for (const element of block.elements) for (const node of element.slice(1)) partNodes.add(node);
  const boxMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const boxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of partNodes) {
    const at = coordinates.get(node);
    if (at !== undefined)
      for (const axis of [0, 1, 2] as const)
        [boxMin[axis], boxMax[axis]] = [Math.min(boxMin[axis], at[axis]), Math.max(boxMax[axis], at[axis])];
  }
  const size = Math.hypot(boxMax[0] - boxMin[0], boxMax[1] - boxMin[1], boxMax[2] - boxMin[2]);
  return proceed({ entityIds, partNodes, boxMin, boxMax, size });
}

/** The cylindrical-quantity axis (default: through the box centre along z), or a refusal for a zero direction. */
export function axisOf(doc: CadDocument, params: InputParams, parts: PartSelection): Phase<AxisFrame> {
  const { boxMin, boxMax } = parts;
  const axis = axisFrame(
    params.axisPoint ?? [(boxMin[0] + boxMax[0]) / 2, (boxMin[1] + boxMax[1]) / 2, (boxMin[2] + boxMax[2]) / 2],
    params.axisDirection ?? [0, 0, 1],
  );
  return axis === null ? stop(invalid(doc, 'axisDirection must be a non-zero vector', 'axisDirection')) : proceed(axis);
}

/** The unit-normal section plane, null without one; a degenerate plane is refused. */
export function cutOf(doc: CadDocument, params: InputParams): Phase<CutPlane | null> {
  if (params.cut === undefined) return proceed(null);
  const [nx, ny, nz] = params.cut.normal;
  const length = Math.hypot(nx, ny, nz);
  if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(params.cut.offset))
    return stop(invalid(doc, 'cut.normal must be a finite non-zero vector and cut.offset a finite number', 'cut'));
  return proceed({ normal: [nx / length, ny / length, nz / length], offset: params.cut.offset });
}

/** The part nodes on the kept side of the cut. */
export function plottedNodes(partNodes: ReadonlySet<number>, coordinates: ReadonlyMap<number, Vec3>, cut: CutPlane | null): Set<number> {
  const kept = (node: number): boolean => {
    const at = coordinates.get(node);
    return at !== undefined && (cut === null || cut.normal[0] * at[0] + cut.normal[1] * at[1] + cut.normal[2] * at[2] <= cut.offset);
  };
  return new Set([...partNodes].filter(kept));
}

export interface Deformation {
  readonly scale: number;
  readonly maxDisplacement: number;
  readonly deformed: (node: number) => Vec3 | undefined;
}

/** The displacement magnification (explicit or automatic) and the deformed position of a node. */
export function deformationOf(
  analysis: AnalysisCase,
  selected: Selected,
  parts: PartSelection,
  coordinates: ReadonlyMap<number, Vec3>,
  deformationScale: number | undefined,
): Deformation {
  const displacement = isHeat(analysis) ? undefined : selected.step.fields['DISP']?.values;
  let maxDisplacement = 0;
  for (const node of parts.partNodes) maxDisplacement = Math.max(maxDisplacement, magnitude(displacement?.[String(node)] ?? []));
  const scale =
    deformationScale ?? (maxDisplacement > 0 ? Number(significantNumber((AUTO_DEFORMATION * parts.size) / maxDisplacement, 2)) : 0);
  const deformed = (node: number): Vec3 | undefined => {
    const at = coordinates.get(node);
    if (at === undefined) return undefined;
    const [ux = 0, uy = 0, uz = 0] = displacement?.[String(node)] ?? [];
    return [at[0] + scale * ux, at[1] + scale * uy, at[2] + scale * uz];
  };
  return { scale, maxDisplacement, deformed };
}
