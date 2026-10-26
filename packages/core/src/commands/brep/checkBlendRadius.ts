/**
 * Radius readback of check_blends (BLD M1): the realised radius along each edge blend (`radius { min, max, at }`) and, where the recipe's law
 * can be compared end to end, the finding BLD_CHECK_RADIUS_LAW when the blend is off the law.
 * @invariant a law is compared only where it is exact (constant, straight pieces, or smooth at its control points) and only on an edge that is
 *   alone in its tangent chain (the kernel reads relative positions per picked edge)
 */

import { roundSignificant } from '../../lib/significant';
import {
  type BlendFaceContacts,
  blendSectionsOf,
  exactParameters,
  filletNodes,
  isolatedEdge,
  lawsOfNode,
  radiusAtT,
  radiusSamples,
  sameDirection,
} from '../../geometry/blend/blendInfo';
import { controlParameters, radiusAt } from '../../geometry/blend/law';
import type { GeometryKernel, ShapeTopology } from '../../geometry/kernel';
import type { ShapeHandle } from '../../geometry/kernelTypes';
import type { EdgeRadius, ShapeRecipe } from '../../model/types';
import type { BlendProfile } from '../../model/blendTypes';

const sig = (value: number): number => roundSignificant(value, 10);

/** Sections read per blend face (min, max and the law comparison come from this grid). */
const FINE_SECTIONS = 101;
/** Relative deviation from the law above which the blend is off the law (named default, TECHNICAL_SPEC §7.1). */
export const RADIUS_LAW_TOLERANCE = 1e-4;

export interface RadiusReadback {
  readonly min: number;
  readonly max: number;
  readonly at: ReadonlyArray<{ readonly t: number; readonly value: number }>;
}

export interface RadiusFinding {
  readonly face: number;
  readonly t: number;
  readonly expected: number;
  readonly actual: number;
  readonly deviation: number;
}

export interface RadiusCheck {
  readonly radius: RadiusReadback | null;
  /** The law was compared with the blend (false: not comparable, or the kernel cannot section). */
  readonly lawChecked: boolean;
  readonly deviations: readonly RadiusFinding[];
}

export interface LawRecord {
  /** Position of the fillet node (outermost first) the record comes from: blends of one node are rounded together, of two nodes in two steps. */
  readonly node: number;
  readonly law: EdgeRadius;
  /** The section the recipe asked for (absent = circular). */
  readonly profile?: BlendProfile;
  readonly shape: ShapeHandle;
  readonly topology: ShapeTopology;
  readonly edge: number;
}

/** The law given to each source edge (by persistent name) in the fillet nodes of `recipe`. */
export function lawIndex(kernel: GeometryKernel, recipe: ShapeRecipe): Map<string, LawRecord> {
  const index = new Map<string, LawRecord>();
  for (const [position, node] of filletNodes(recipe).entries()) {
    const shape = kernel.evaluate(node.source);
    const topology = shape === null ? null : kernel.topology(shape);
    if (shape === null || topology === null) continue;
    const laws = lawsOfNode(node);
    node.edges.forEach((edge, at) => {
      const name = topology.edges[edge]?.name;
      const law = laws[at];
      if (name !== undefined && law !== undefined && !index.has(name))
        index.set(name, { node: position, law, shape, topology, edge, ...(node.profile === undefined ? {} : { profile: node.profile }) });
    });
  }
  return index;
}

/** The radius along `blend` at `samples` uniform fractions plus the law's control points, and its deviation from the law. */
export function checkRadius(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  blend: BlendFaceContacts,
  record: LawRecord | undefined,
  samples: number,
): RadiusCheck {
  // a conic / curvature section has no radius: the circle through three of its points would be a number without meaning
  if (record?.profile !== undefined && record.profile.type !== 'circular') return { radius: null, lawChecked: false, deviations: [] };
  const sections = blendSectionsOf(kernel, shape, blend, FINE_SECTIONS);
  const fine = sections === null ? null : radiusSamples(sections);
  if (sections === null || fine === null) return { radius: null, lawChecked: false, deviations: [] };
  const radii = fine.map((sample) => sample.radius);
  const direction =
    record === undefined
      ? null
      : sameDirection(sections, (t) => kernel.faceQuery?.edgeSamples(record.shape, record.edge, 5)?.[Math.round(t * 4)]?.point ?? null);
  const grid = Array.from({ length: samples }, (_, k) => k / (samples - 1));
  const lawT = record === undefined || direction === null ? [] : controlParameters(record.law).map((u) => (direction ? u : 1 - u));
  const at = [...new Set([...grid, ...lawT].map((t) => sig(t)))].sort((a, b) => a - b).map((t) => ({ t, value: sig(radiusAtT(fine, t)) }));
  const radius = { min: sig(Math.min(...radii)), max: sig(Math.max(...radii)), at };
  const comparable =
    record !== undefined &&
    direction !== null &&
    (record.law.sizeEnd === undefined && (record.law.sizes ?? []).length === 0 ? true : isolatedEdge(record.topology, record.edge));
  if (!comparable || record === undefined || direction === null) return { radius, lawChecked: false, deviations: [] };
  const exact = exactParameters(record.law);
  const parameters = exact === 'all' ? Array.from({ length: 21 }, (_, k) => k / 20) : exact;
  const deviations: RadiusFinding[] = [];
  for (const u of parameters) {
    const t = direction ? u : 1 - u;
    const expected = radiusAt(record.law, u);
    const actual = radiusAtT(fine, t);
    if (Math.abs(actual - expected) > RADIUS_LAW_TOLERANCE * expected)
      deviations.push({
        face: blend.face,
        t: sig(t),
        expected: sig(expected),
        actual: sig(actual),
        deviation: sig(Math.abs(actual - expected)),
      });
  }
  return { radius, lawChecked: true, deviations };
}
