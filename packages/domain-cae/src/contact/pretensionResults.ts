/**
 * Bolt results of a nonlinear_static solve (PHY-06 FR-CNT-03/04, TR-CNT-10): the force through each pretension section integrated from the nodal
 * stress on the cut faces (axial force, transverse shear, bending moment, torsion), the bolt shortening read from the reference node, and the
 * clamp-zone closure of the contact pairs around each bolt (joint separation, TECHNICAL_SPEC §5.4).
 */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { BoltPretension } from '@core/model/contact';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, scale3, sub3 } from '@lib/vec3';
import { faceNodes, indexMesh, type MeshIndex } from '../thermal/meshGeometry';
import { BLOCK, COMPONENTS, slaveAreas } from './reader';
import { preloadForce } from './pretensionDeck';
import { isCutRefusal, numberDuplicates, outwardAreaVector, pretensionCut, type PretensionCut } from './pretensionSection';

type Step = FeResultsArtifact['steps'][number];

/** Radius of the clamp zone around the bolt axis in bolt diameters (TECHNICAL_SPEC §5.4: a cylinder of 3 x the diameter; llull rule). */
export const CLAMP_ZONE_RADIUS_DIAMETERS = 1.5;

/** Components of the frd `STRESS` block, in the tensor order below. */
const STRESS = ['SXX', 'SYY', 'SZZ', 'SXY', 'SYZ', 'SZX'] as const;

export interface BoltRow {
  readonly pretensionId: string;
  readonly name: string;
  readonly stepId: string;
  readonly solverStep: number;
  readonly time: number;
  /** Preload the deck applies (analysis force unit). */
  readonly preload: number;
  /** Tension positive along the section normal; analysis force unit. */
  readonly axialForce: number;
  readonly shearForce: number;
  /** Moments about the section centroid: bending (transverse to the axis) and torsion (about it); analysis force x length. */
  readonly bendingMoment: number;
  readonly torsion: number;
  /** Cross-check of axialForce: -(sum of RF over the duplicate nodes) . n, the force the equations carry; null when the table is absent. */
  readonly reactionForce: number | null;
  /** Shortening of the reference node = degree of freedom 1 of the reference node (analysis length), null when its table is absent. */
  readonly shortening: number | null;
  /** Faces of the cut with stress at all three nodes / all faces. */
  readonly facesUsed: number;
  readonly faces: number;
}

export interface ClampRow {
  readonly pretensionId: string;
  readonly pairId: string;
  readonly stepId: string;
  readonly solverStep: number;
  readonly time: number;
  /** Slave area inside the clamp zone and the fraction of it in contact (CPRESS > 0). */
  readonly zoneArea: number;
  readonly closedFraction: number;
}

export interface Separation {
  readonly pretensionId: string;
  readonly pairId: string;
  readonly stepId: string;
  readonly solverStep: number;
  /** Total time of the first stored increment in which the whole clamp zone of the pair is open. */
  readonly time: number;
}

/** A bolt with its cut on the current mesh. */
export interface BoltCut {
  readonly bolt: BoltPretension;
  readonly position: number;
  readonly cut: PretensionCut;
  /** Cut node -> its duplicate in the deck (the node the high side carries). */
  readonly duplicates: ReadonlyMap<number, number>;
}

/**
 * The cut of every bolt of the case on `mesh`.
 * @failure a bolt whose cut cannot be made -> { code, message, ids }
 */
export function boltCuts(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  lengthToAnalysis: number,
  index: MeshIndex = indexMesh(mesh),
): BoltCut[] | { readonly code: string; readonly message: string; readonly ids: readonly string[] } {
  const found: { bolt: BoltPretension; position: number; cut: PretensionCut }[] = [];
  for (const [position, id] of (analysis.pretension?.order ?? []).entries()) {
    const bolt = analysis.pretension?.bolts[id];
    if (bolt === undefined) continue;
    const point = scale3(bolt.section.point, lengthToAnalysis);
    const cut = pretensionCut(mesh, bolt.entityId, point, bolt.section.normal, index);
    if (isCutRefusal(cut)) return { code: cut.code, message: `bolt '${bolt.id}' (${bolt.name}): ${cut.message}`, ids: [bolt.id] };
    found.push({ bolt, position, cut });
  }
  const numbered = numberDuplicates(
    mesh,
    found.map((entry) => entry.cut),
  );
  return found.map((entry, order) => ({ ...entry, duplicates: numbered[order] ?? new Map() }));
}

const lastOf = (sets: readonly Step[], increments: 'summary' | 'all'): readonly Step[] => (increments === 'all' ? sets : sets.slice(-1));

/** Steps of the solve belonging to analysis step `position` (CalculiX step number position + 1). */
const setsOfStep = (results: FeResultsArtifact, position: number): Step[] => results.steps.filter((step) => step.step === position + 1);

/** Symmetric stress tensor, one row per axis. */
type Tensor = readonly [Vec3, Vec3, Vec3];

/** Stress tensor of node `node` from the frd STRESS block (null when the node or one of the six components is absent). */
function stressAt(step: Step, columns: readonly number[], node: number): Tensor | null {
  const values = step.fields['STRESS']?.values[String(node)];
  if (values === undefined) return null;
  const [xx, yy, zz, xy, yz, zx] = columns.map((column) => (column < 0 ? undefined : values[column]));
  if (xx === undefined || yy === undefined || zz === undefined || xy === undefined || yz === undefined || zx === undefined) return null;
  return [
    [xx, xy, zx],
    [xy, yy, yz],
    [zx, yz, zz],
  ];
}

const midpoint = (a: Vec3, b: Vec3): Vec3 => scale3(add3(a, b), 0.5);
const meanOf = (a: Tensor, b: Tensor): Tensor => [midpoint(a[0], b[0]), midpoint(a[1], b[1]), midpoint(a[2], b[2])];

/** Mean of the low-side and high-side nodal tensors of a cut node (both sides carry the same traction; one-sided extrapolation errors average out). */
const meanTensor = (low: Tensor | null, high: Tensor | null): Tensor | null =>
  low === null || high === null ? (low ?? high) : meanOf(low, high);

const apply = (tensor: Tensor, vector: Vec3): Vec3 => [dot3(tensor[0], vector), dot3(tensor[1], vector), dot3(tensor[2], vector)];

/** Shortening of the reference node (U1) printed at the stored time `time`, from the `.dat` tables. */
/** Summed reaction (fx, fy, fz) of the duplicate nodes of bolt `position`, from the `TOTALS=ONLY` table of the stored time `time`. */
function duplicateReactionAt(results: FeResultsArtifact, position: number, time: number): Vec3 | null {
  const marker = ` FOR SET PTD_${position + 1} AND TIME`;
  for (const table of results.dat?.tables ?? []) {
    const [fx, fy, fz] = table.rows[0] ?? [];
    if (
      table.title.toLowerCase().startsWith('total force') &&
      table.title.toUpperCase().includes(marker) &&
      Math.abs(table.time - time) <= 1e-9 * Math.max(1, Math.abs(time)) &&
      fx !== undefined &&
      fy !== undefined &&
      fz !== undefined
    )
      return [fx, fy, fz];
  }
  return null;
}

function shorteningAt(results: FeResultsArtifact, position: number, time: number): number | null {
  const marker = ` FOR SET PTN_${position + 1} AND TIME`;
  for (const table of results.dat?.tables ?? [])
    if (
      table.title.toLowerCase().startsWith('displacements') &&
      table.title.toUpperCase().includes(marker) &&
      Math.abs(table.time - time) <= 1e-9 * Math.max(1, Math.abs(time))
    )
      return table.rows[0]?.[1] ?? null;
  return null;
}

/** Integral of the traction `sigma . dA` over the cut faces of one bolt at one stored increment. */
function sectionIntegral(
  index: MeshIndex,
  planned: BoltCut,
  step: Step,
): { readonly force: Vec3; readonly moment: Vec3; readonly used: number } {
  const columns = STRESS.map((name) => (step.fields['STRESS']?.components ?? []).indexOf(name));
  const tensorAt = (node: number): Tensor | null => {
    const copy = planned.duplicates.get(node);
    return meanTensor(stressAt(step, columns, node), copy === undefined ? null : stressAt(step, columns, copy));
  };
  let force: Vec3 = [0, 0, 0];
  let moment: Vec3 = [0, 0, 0];
  let used = 0;
  for (const [elementId, label] of planned.cut.faces) {
    const element = index.elements.get(elementId);
    const [n0, n1, n2] = (element === undefined ? null : faceNodes(element, label)) ?? [];
    if (element === undefined || n0 === undefined || n1 === undefined || n2 === undefined) continue;
    const [a, b, c] = [n0, n1, n2].map((node) => index.coordinates.get(node));
    const [ta, tb, tc] = [n0, n1, n2].map(tensorAt);
    if (a === undefined || b === undefined || c === undefined || !ta || !tb || !tc) continue;
    const outward = outwardAreaVector(index, element, a, b, c);
    // edge-midpoint rule (exact for the quadratic integrand r x sigma of a linear stress field): sigma at a midpoint = mean of its two end nodes
    const sides: readonly (readonly [Vec3, Tensor, Vec3, Tensor])[] = [
      [a, ta, b, tb],
      [b, tb, c, tc],
      [c, tc, a, ta],
    ];
    for (const [from, fromTensor, to, toTensor] of sides) {
      const traction = scale3(apply(meanOf(fromTensor, toTensor), outward), 1 / 3);
      force = add3(force, traction);
      moment = add3(moment, cross3(sub3(midpoint(from, to), planned.cut.centroid), traction));
    }
    used += 1;
  }
  return { force, moment, used };
}

/**
 * One row per (bolt, analysis step) from the last stored increment of each step (`all`: every stored increment), bolts in creation order.
 * Axial force = (sigma . A) . n summed over the faces of the cut, tension positive along the section normal; nodal stress averaged between
 * the low-side node and its duplicate (the extrapolated, element-averaged frd STRESS block). `reactionForce` is the independent cross-check: minus the summed
 * CalculiX reaction (the equation force) of the duplicate nodes along the normal.
 * @invariant a stored increment without a STRESS block gives zero faces used (the caller reports it)
 */
export function boltRows(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  cuts: readonly BoltCut[],
  lengthToAnalysis: number,
  increments: 'summary' | 'all' = 'summary',
): BoltRow[] {
  const index = indexMesh(mesh);
  const rows: BoltRow[] = [];
  for (const planned of cuts)
    (analysis.nonlinear?.stepOrder ?? []).forEach((stepId, position) => {
      for (const step of lastOf(setsOfStep(results, position), increments)) {
        const { force, moment, used } = sectionIntegral(index, planned, step);
        const axis = planned.cut.normal;
        const axial = dot3(force, axis);
        const torsion = dot3(moment, axis);
        rows.push({
          pretensionId: planned.bolt.id,
          name: planned.bolt.name,
          stepId,
          solverStep: step.step,
          time: step.time,
          preload: preloadForce(planned.bolt.preload, lengthToAnalysis),
          axialForce: axial,
          shearForce: Math.hypot(...sub3(force, scale3(axis, axial))),
          bendingMoment: Math.hypot(...sub3(moment, scale3(axis, torsion))),
          torsion,
          reactionForce: ((total) => (total === null ? null : -dot3(total, axis)))(
            duplicateReactionAt(results, planned.position, step.time),
          ),
          shortening: shorteningAt(results, planned.position, step.time),
          facesUsed: used,
          faces: planned.cut.faces.length,
        });
      }
    });
  return rows;
}

/**
 * Clamp-zone closure of every (bolt, pair) at every stored increment (the caller keeps the last per step and the first separation): the slave
 * nodes of the pair within 1.5 bolt diameters of the bolt axis, their tributary areas and the part of it with CPRESS > 0.
 * @invariant pairs without slave faces on the mesh, or results without the CONTACT block, give no row
 */
export function clampRows(analysis: AnalysisCase, mesh: FeMeshArtifact, results: FeResultsArtifact, cuts: readonly BoltCut[]): ClampRow[] {
  const settings = analysis.contact;
  const withBlock = results.steps.find((step) => step.fields[BLOCK] !== undefined);
  const components = withBlock?.fields[BLOCK]?.components ?? [];
  const press = components.indexOf(COMPONENTS[3]);
  if (settings === undefined || press < 0) return [];
  const index = indexMesh(mesh);
  const rows: ClampRow[] = [];
  for (const planned of cuts) {
    const radius = CLAMP_ZONE_RADIUS_DIAMETERS * planned.cut.diameter;
    const axis = planned.cut.normal;
    for (const pairId of settings.pairOrder) {
      const pair = settings.pairs[pairId];
      if (pair === undefined) continue;
      const zone = [...slaveAreas(index, mesh, pair)].filter(([node]) => {
        const at = index.coordinates.get(node);
        if (at === undefined) return false;
        const offset = sub3(at, planned.cut.centroid);
        return Math.hypot(...sub3(offset, scale3(axis, dot3(offset, axis)))) <= radius;
      });
      const zoneArea = zone.reduce((sum, [, area]) => sum + area, 0);
      if (zoneArea <= 0) continue;
      (analysis.nonlinear?.stepOrder ?? []).forEach((stepId, position) => {
        if (pair.activeSteps !== undefined && !pair.activeSteps.includes(stepId)) return;
        for (const step of setsOfStep(results, position)) {
          const field = step.fields[BLOCK];
          const closed = zone.reduce((sum, [node, area]) => sum + ((field?.values[String(node)]?.[press] ?? 0) > 0 ? area : 0), 0);
          rows.push({
            pretensionId: planned.bolt.id,
            pairId,
            stepId,
            solverStep: step.step,
            time: step.time,
            zoneArea,
            closedFraction: closed / zoneArea,
          });
        }
      });
    }
  }
  return rows;
}

/**
 * First increment in which the whole clamp zone of a (bolt, pair) is open, one per (bolt, pair), in row order. Increments of the preload
 * step before its last one are skipped (the clamp is still being built, a gap may be closing); its last increment counts, so a joint that
 * never closed is reported there.
 */
export function separations(rows: readonly ClampRow[], preloadStepOf: ReadonlyMap<string, string>): Separation[] {
  const lastPreload = new Map<string, ClampRow>();
  for (const row of rows) if (row.stepId === preloadStepOf.get(row.pretensionId)) lastPreload.set(`${row.pretensionId}|${row.pairId}`, row);
  const seen = new Set<string>();
  const out: Separation[] = [];
  for (const row of rows) {
    const id = `${row.pretensionId}|${row.pairId}`;
    const building = row.stepId === preloadStepOf.get(row.pretensionId) && lastPreload.get(id) !== row;
    if (row.closedFraction > 0 || seen.has(id) || building) continue;
    seen.add(id);
    out.push({ pretensionId: row.pretensionId, pairId: row.pairId, stepId: row.stepId, solverStep: row.solverStep, time: row.time });
  }
  return out;
}

/** Last stored increment of every (bolt, pair, step) of `rows`, for the report. */
export function lastClampRows(rows: readonly ClampRow[]): ClampRow[] {
  const last = new Map<string, ClampRow>();
  for (const row of rows) last.set(`${row.pretensionId}|${row.pairId}|${row.stepId}`, row);
  return [...last.values()];
}
