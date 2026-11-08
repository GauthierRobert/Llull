/**
 * Contact results of a nonlinear_static solve (PHY-06 TR-CNT-10, FR-CNT-04): the frd `CONTACT` block that `*CONTACT FILE CDIS, CSTR` writes
 * (COPEN, CSLIP1, CSLIP2, CPRESS, CSHEAR1, CSHEAR2 at the slave nodes), integrated over the slave faces of each pair.
 */

import type { AnalysisCase, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { ContactPair } from '@core/model/contact';
import type { Vec3 } from '@core/model/vectors';
import { cross3, sub3 } from '@lib/vec3';
import { faceNodes, indexMesh, type MeshIndex } from '../thermal/meshGeometry';
import { pairTargetKey } from '../hash/targets';

/** frd block and component names CalculiX writes for CDIS / CSTR. */
export const BLOCK = 'CONTACT';
export const COMPONENTS = ['COPEN', 'CSLIP1', 'CSLIP2', 'CPRESS', 'CSHEAR1', 'CSHEAR2'] as const;

/** A closed slave node slides when its shear reaches this fraction of mu x pressure (llull rule: Coulomb limit within 1 %). */
export const SLIDING_FRACTION = 0.99;

export interface ContactRow {
  readonly pairId: string;
  readonly stepId: string;
  /** CalculiX step number and total time of the stored increment. */
  readonly solverStep: number;
  readonly time: number;
  /** Slave face area (analysis length unit squared) and its closed / sliding parts (tributary corner areas). */
  readonly totalArea: number;
  readonly closedArea: number;
  readonly closedAreaFraction: number;
  readonly slidingAreaFraction: number;
  readonly maxPressure: { readonly value: number; readonly node: number; readonly at: Vec3 } | null;
  /** Pressure averaged over the closed area. */
  readonly meanPressure: number;
  /** Sum of pressure x tributary area (normal contact force estimate). */
  readonly normalForce: number;
  /** Sum of |shear| x tributary area (friction force when the shear has one direction, as on a sliding flat interface). */
  readonly shearForce: number;
  /** Largest penetration = max(0, -COPEN): COPEN < 0 is the overclosure (penetration = pressure / penalty slope on CalculiX 2.21, TECHNICAL_SPEC §13.2). */
  readonly maxPenetration: number;
  readonly maxSlip: number;
  /** Bounding box of the closed slave nodes (analysis length unit), null when the pair is open. */
  readonly closedBox: { readonly min: Vec3; readonly max: Vec3 } | null;
}

type Step = FeResultsArtifact['steps'][number];

/** Tributary area of every slave corner node of `pair` (face area / 3 per corner). */
export function slaveAreas(index: MeshIndex, mesh: FeMeshArtifact, pair: ContactPair): Map<number, number> {
  const areas = new Map<number, number>();
  const key = pairTargetKey(pair.id, 'S');
  for (const [elementId, label] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : []) {
    const element = index.elements.get(elementId);
    const nodes = element === undefined ? null : faceNodes(element, label);
    if (nodes === null) continue;
    const corners = nodes.slice(0, 3).map((node) => index.coordinates.get(node));
    const [a, b, c] = corners;
    if (a === undefined || b === undefined || c === undefined) continue;
    const area = Math.hypot(...cross3(sub3(b, a), sub3(c, a))) / 2;
    for (const node of nodes.slice(0, 3)) areas.set(node, (areas.get(node) ?? 0) + area / 3);
  }
  return areas;
}

function rowOf(
  pair: ContactPair,
  stepId: string,
  step: Step,
  areas: ReadonlyMap<number, number>,
  columns: readonly number[],
  index: MeshIndex,
): ContactRow {
  const field = step.fields[BLOCK];
  const [open, slip1, slip2, press, shear1, shear2] = columns;
  const value = (values: readonly number[], column: number | undefined): number => (column === undefined ? 0 : (values[column] ?? 0));
  let totalArea = 0;
  let closedArea = 0;
  let slidingArea = 0;
  let force = 0;
  let shearForce = 0;
  let maxPenetration = 0;
  let maxSlip = 0;
  let peak: ContactRow['maxPressure'] = null;
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const [node, area] of areas) {
    totalArea += area;
    const values = field?.values[String(node)];
    if (values === undefined) continue;
    const pressure = value(values, press);
    maxPenetration = Math.max(maxPenetration, -value(values, open));
    maxSlip = Math.max(maxSlip, Math.hypot(value(values, slip1), value(values, slip2)));
    if (!(pressure > 0)) continue;
    closedArea += area;
    force += pressure * area;
    const at = index.coordinates.get(node) ?? [0, 0, 0];
    if (peak === null || pressure > peak.value) peak = { value: pressure, node, at };
    min = min === null ? [...at] : [Math.min(min[0], at[0]), Math.min(min[1], at[1]), Math.min(min[2], at[2])];
    max = max === null ? [...at] : [Math.max(max[0], at[0]), Math.max(max[1], at[1]), Math.max(max[2], at[2])];
    const shear = Math.hypot(value(values, shear1), value(values, shear2));
    shearForce += shear * area;
    const mu = pair.friction?.mu;
    if (mu !== undefined && shear >= SLIDING_FRACTION * mu * pressure) slidingArea += area;
  }
  return {
    pairId: pair.id,
    stepId,
    solverStep: step.step,
    time: step.time,
    totalArea,
    closedArea,
    closedAreaFraction: totalArea > 0 ? closedArea / totalArea : 0,
    slidingAreaFraction: totalArea > 0 ? slidingArea / totalArea : 0,
    maxPressure: peak,
    meanPressure: closedArea > 0 ? force / closedArea : 0,
    normalForce: force,
    shearForce,
    maxPenetration,
    maxSlip,
    closedBox: min === null || max === null ? null : { min, max },
  };
}

/**
 * One row per (pair, analysis step) from the last stored increment of each step (`all`: every stored increment), pairs in creation order.
 * Analysis step n is CalculiX step n; a pair inactive in a step (activeSteps) gives no row there.
 * @failure no stored increment carries a CONTACT block with the six components -> CNT_CONTACT_RESULTS_MISSING
 */
export function contactRows(
  analysis: AnalysisCase,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
  increments: 'summary' | 'all' = 'summary',
): ContactRow[] | { readonly code: string; readonly message: string } {
  const settings = analysis.contact;
  const withBlock = results.steps.find((step) => step.fields[BLOCK] !== undefined);
  const components = withBlock?.fields[BLOCK]?.components ?? [];
  const columns = COMPONENTS.map((name) => components.indexOf(name));
  if (withBlock === undefined || columns.some((column) => column < 0))
    return {
      code: 'CNT_CONTACT_RESULTS_MISSING',
      message: `no stored increment has a ${BLOCK} block with ${COMPONENTS.join(', ')} (found: ${components.join(', ') || 'none'})`,
    };
  const index = indexMesh(mesh);
  const rows: ContactRow[] = [];
  for (const pairId of settings?.pairOrder ?? []) {
    const pair = settings?.pairs[pairId];
    if (pair === undefined) continue;
    const areas = slaveAreas(index, mesh, pair);
    (analysis.nonlinear?.stepOrder ?? []).forEach((stepId, position) => {
      if (pair.activeSteps !== undefined && !pair.activeSteps.includes(stepId)) return;
      const stored = results.steps.filter((step) => step.step === position + 1);
      for (const step of increments === 'all' ? stored : stored.slice(-1)) rows.push(rowOf(pair, stepId, step, areas, columns, index));
    });
  }
  return rows;
}
