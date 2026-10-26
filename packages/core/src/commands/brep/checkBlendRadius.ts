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
import type { BlendSection } from '../../geometry/kernelPorts';
import type { EdgeRadius, ShapeRecipe, Vec3 } from '../../model/types';
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
  /** The node has setback corners: its blends stop short of the edge ends, so a law that varies along the edge is not compared over the blend face. */
  readonly setback: boolean;
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
        index.set(name, {
          node: position,
          law,
          shape,
          topology,
          edge,
          setback: (node.corners ?? []).length > 0,
          ...(node.profile === undefined ? {} : { profile: node.profile }),
        });
    });
  }
  return index;
}

/**
 * The part of a straight source edge a setback blend covers, as fractions of the edge (`lo` < `hi`) with the direction of the sections along it: the first and
 * last section mid points projected on the edge line. Null for a curved edge or a degenerate projection.
 */
function setbackSpan(sections: readonly BlendSection[], record: LawRecord): { lo: number; hi: number; forward: boolean } | null {
  const edge = record.topology.edges[record.edge];
  const first = sections[0]?.mid;
  const last = sections[sections.length - 1]?.mid;
  if (edge === undefined || edge.curve !== 'line' || first === undefined || last === undefined) return null;
  const along = [0, 1, 2].map((axis) => (edge.end[axis] ?? 0) - (edge.start[axis] ?? 0));
  const length2 = along.reduce((sum, value) => sum + value * value, 0);
  if (!(length2 > 0)) return null;
  const fraction = (point: Vec3): number =>
    along.reduce((sum, value, axis) => sum + value * ((point[axis] ?? 0) - (edge.start[axis] ?? 0)), 0) / length2;
  const [from, to] = [fraction(first), fraction(last)];
  return Math.abs(to - from) < 1e-9 ? null : { lo: Math.min(from, to), hi: Math.max(from, to), forward: to > from };
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
  // A setback blend stops short of the edge ends: the law is read over the span it covers, not over the whole edge.
  const span = record?.setback === true ? setbackSpan(sections, record) : null;
  const direction =
    record === undefined
      ? null
      : span !== null
        ? span.forward
        : sameDirection(sections, (t) => kernel.faceQuery?.edgeSamples(record.shape, record.edge, 5)?.[Math.round(t * 4)]?.point ?? null);
  const grid = Array.from({ length: samples }, (_, k) => k / (samples - 1));
  const lawT =
    record === undefined || direction === null || span !== null ? [] : controlParameters(record.law).map((u) => (direction ? u : 1 - u));
  const at = [...new Set([...grid, ...lawT].map((t) => sig(t)))].sort((a, b) => a - b).map((t) => ({ t, value: sig(radiusAtT(fine, t)) }));
  const radius = { min: sig(Math.min(...radii)), max: sig(Math.max(...radii)), at };
  const comparable =
    record !== undefined &&
    direction !== null &&
    (record.law.sizeEnd === undefined && (record.law.sizes ?? []).length === 0 ? true : isolatedEdge(record.topology, record.edge));
  if (!comparable || record === undefined || direction === null || (record.setback && span === null))
    return { radius, lawChecked: false, deviations: [] };
  const exact = exactParameters(record.law);
  const parameters = exact === 'all' || span !== null ? Array.from({ length: 21 }, (_, k) => k / 20) : exact;
  const deviations: RadiusFinding[] = [];
  for (const u of parameters) {
    // without a span `u` is the position on the edge; with one it is the position on the blend, mapped onto the edge fractions the blend covers
    const t = span !== null ? u : direction ? u : 1 - u;
    const onEdge = span === null ? u : span.forward ? span.lo + u * (span.hi - span.lo) : span.hi - u * (span.hi - span.lo);
    const expected = radiusAt(record.law, onEdge);
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
