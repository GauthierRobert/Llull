/**
 * Chord sizing of fillets (FR-BLD-04, TECHNICAL_SPEC §5.2): a size is the chord between the two tangent points of the round, converted to a
 * radius `r = c / (2 cos(wedge / 2))`. Planar face pair: one closed-form factor per edge. Any other pair (a cylinder rim against its cap): the
 * wedge between the face tangent lines is read at `CHORD_SAMPLES` points along the edge (`edgeContinuity`) and the law is multiplied by the
 * sampled factor.
 * @failure faces tangent or folded flat at a sample -> BLD_CHORD_UNDEFINED; no face adjacency / continuity from the kernel -> plain problem
 */

import type { EdgeRadius } from '../../model/types';
import type { GeometryKernel, ShapeHandle, ShapeTopology } from '../../geometry/kernel';
import { CHORD_SAMPLES, lawTimesFactors, scaleLaw } from '../../geometry/blend/law';
import { chordToRadius, wedgeAngle } from './filletSpec';

export interface ChordInput {
  readonly edge: number;
  readonly law: EdgeRadius;
}

export type ChordResult =
  | { readonly planned: ReadonlyArray<ChordInput> }
  | { readonly problem: string; readonly code?: 'BLD_CHORD_UNDEFINED'; readonly edge?: number };

/** Smallest fold from tangent (and from a knife edge) for which a chord still defines a radius, radians. */
const MIN_FOLD = 1e-3;

/** Chord -> radius factor 1 / (2 cos(wedge / 2)) from the angle g1 between the outward normals; NaN when tangent or folded flat. */
function factorOfNormalAngle(g1: number): number {
  return g1 > MIN_FOLD && g1 < Math.PI - MIN_FOLD ? chordToRadius(1, Math.PI - g1) : Number.NaN;
}

/** `planned` with every chord law turned into a radius law. */
export function chordsToRadii(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology | null,
  planned: readonly ChordInput[],
): ChordResult {
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  if (topology === null || graph === null)
    return { problem: 'mode "chord" needs the exact face adjacency of an exact kernel (the mesh kernel has none)' };
  const converted: ChordInput[] = [];
  for (const { edge, law } of planned) {
    const faces = graph.edgeFaces[edge] ?? [];
    if (faces.length !== 2) return { problem: `mode "chord" needs two faces at edge ${edge} (found ${faces.length})` };
    const [a, b] = faces.map((face) => topology.faces[face]?.normal);
    if (a !== undefined && b !== undefined) {
      const factor = chordToRadius(1, wedgeAngle(a, b));
      if (!Number.isFinite(factor))
        return {
          problem: `edge ${edge} joins faces that are tangent or folded flat (no corner to take a chord from)`,
          code: 'BLD_CHORD_UNDEFINED',
          edge,
        };
      converted.push({ edge, law: scaleLaw(law, factor) });
      continue;
    }
    const samples = kernel.faceQuery?.edgeContinuity(shape, edge, CHORD_SAMPLES) ?? null;
    if (samples === null)
      return {
        problem: `mode "chord" needs two planar faces at edge ${edge}, or a kernel that measures the wedge angle along it (edgeContinuity)`,
      };
    const factors = samples.map((sample) => factorOfNormalAngle(sample.g1));
    const bad = factors.findIndex((factor) => !Number.isFinite(factor));
    if (bad >= 0)
      return {
        problem: `the faces at edge ${edge} are tangent or folded flat at t = ${(samples[bad]?.t ?? 0).toFixed(3)} (no corner to take a chord from)`,
        code: 'BLD_CHORD_UNDEFINED',
        edge,
      };
    converted.push({ edge, law: lawTimesFactors(law, factors) });
  }
  return { planned: converted };
}
