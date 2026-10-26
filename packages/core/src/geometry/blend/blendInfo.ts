/**
 * Readback of the blends of a shape (BLD M1, TECHNICAL_SPEC §3, §5.9): per blend face its contact edges and the radius of its cross-section
 * along the face, from the kernel's `blendSections`; the law a recipe asked for at a source edge; the comparison of the two.
 * @invariant pure over a kernel's answers; radii in document units; `t` of a section is the fraction along the FIRST contact edge
 */

import type { EdgeRadius, ShapeRecipe, Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeTopology } from '../kernel';
import type { BlendSection, FaceGraph } from '../kernelPorts';
import type { ShapeHandle } from '../kernelTypes';
import { blendSource } from './continuity';

/** The blend faces of an edge fillet and where each meets its two support faces. */
export interface BlendFaceContacts {
  readonly face: number;
  readonly name: string;
  /** Persistent name of the source edge (`e(<A>|<B>)`). */
  readonly sourceEdge: string;
  /** The two edges between the blend and its supports (unique-edge indices). */
  readonly contacts: readonly [number, number];
}

export interface RadiusSample {
  readonly t: number;
  readonly radius: number;
}

/** The blend faces named `blend(e(A|B))` with exactly one contact edge on each support face; faces without both contacts are skipped. */
export function blendFaceContacts(topology: ShapeTopology, graph: FaceGraph): BlendFaceContacts[] {
  const found: BlendFaceContacts[] = [];
  for (const face of topology.faces) {
    const source = face.name === undefined ? null : blendSource(face.name);
    if (source === null || face.name === undefined) continue;
    const edges: number[] = [];
    for (const supportName of source.supports) {
      const edge = graph.edgeFaces.findIndex((around, index) => {
        const names = around.map((other) => topology.faces[other]?.name);
        return around.length === 2 && around.includes(face.index) && names.includes(supportName) && !edges.includes(index);
      });
      if (edge >= 0) edges.push(edge);
    }
    const [first, second] = edges;
    if (first !== undefined && second !== undefined)
      found.push({ face: face.index, name: face.name, sourceEdge: source.edge, contacts: [first, second] });
  }
  return found;
}

/** The cross-sections of a blend face at `count` uniform fractions of its first contact edge; null when the kernel cannot section the face. */
export function blendSectionsOf(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  blend: BlendFaceContacts,
  count: number,
): readonly BlendSection[] | null {
  const sections = kernel.faceQuery?.blendSections?.(shape, blend.face, blend.contacts[0], blend.contacts[1], count) ?? null;
  return sections === null || sections.length === 0 ? null : sections;
}

/** The radius samples of `sections`; null when one section is flat (no circle). */
export function radiusSamples(sections: readonly BlendSection[]): readonly RadiusSample[] | null {
  const samples: RadiusSample[] = [];
  for (const section of sections) {
    if (section.radius === null) return null;
    samples.push({ t: section.t, radius: section.radius });
  }
  return samples;
}

/** Radius at fraction `t` by linear interpolation between the two neighbouring samples (samples sorted by `t`). */
export function radiusAtT(samples: readonly RadiusSample[], t: number): number {
  const upper = samples.findIndex((sample) => sample.t >= t - 1e-12);
  const to = samples[upper];
  if (to === undefined) return samples[samples.length - 1]?.radius ?? Number.NaN;
  const from = samples[upper - 1];
  if (from === undefined || to.t - t < 1e-12) return to.radius;
  return from.radius + ((to.radius - from.radius) * (t - from.t)) / (to.t - from.t);
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Whether the sections run along the source edge in the same direction as the edge (`true`), against it (`false`), or cannot be told (null):
 * the section mid points at t = 0.25 / 0.75 are compared with the edge points at the same / mirrored fractions.
 */
export function sameDirection(sections: readonly BlendSection[], edgeAt: (t: number) => Vec3 | null): boolean | null {
  const at = (t: number): Vec3 | undefined =>
    sections.reduce<BlendSection | undefined>(
      (best, s) => (best === undefined || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best),
      undefined,
    )?.mid;
  const [m1, m3, e1, e3] = [at(0.25), at(0.75), edgeAt(0.25), edgeAt(0.75)];
  if (m1 === undefined || m3 === undefined || e1 === null || e3 === null) return null;
  const forward = distance(m1, e1) + distance(m3, e3);
  const reverse = distance(m1, e3) + distance(m3, e1);
  return Math.abs(forward - reverse) < 1e-9 ? null : forward < reverse;
}

type FilletNode = Extract<ShapeRecipe, { op: 'fillet' | 'chamfer' }>;

/** Every fillet node of `recipe` (through sources and boolean operands), outermost first. */
export function filletNodes(recipe: ShapeRecipe): FilletNode[] {
  switch (recipe.op) {
    case 'fillet':
      return [recipe, ...filletNodes(recipe.source)];
    case 'chamfer':
      return filletNodes(recipe.source);
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return [];
    case 'boolean':
      return [...filletNodes(recipe.a), ...filletNodes(recipe.b)];
    case 'blend':
      return recipe.sources.flatMap(filletNodes);
    default:
      return filletNodes(recipe.source);
  }
}

/** Every blend_union node of `recipe` (through sources and boolean operands), outermost first. */
export function blendNodes(recipe: ShapeRecipe): Array<Extract<ShapeRecipe, { op: 'blend' }>> {
  switch (recipe.op) {
    case 'blend':
      return [recipe, ...recipe.sources.flatMap(blendNodes)];
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return [];
    case 'boolean':
      return [...blendNodes(recipe.a), ...blendNodes(recipe.b)];
    default:
      return blendNodes(recipe.source);
  }
}

/** The radius law each edge of `node` was given. */
export const lawsOfNode = (node: FilletNode): readonly EdgeRadius[] =>
  node.radii ?? node.edges.map(() => ({ size: node.size, ...(node.sizeEnd === undefined ? {} : { sizeEnd: node.sizeEnd }) }));

/** The `t` values at which `law` is exact: every `t` for a constant or straight-piece law, only the control points and the ends for a smooth one. */
export function exactParameters(law: EdgeRadius): readonly number[] | 'all' {
  const constant = law.sizeEnd === undefined && (law.sizes ?? []).length === 0;
  if (constant || law.interpolation === 'linear') return 'all';
  return [0, ...(law.sizes ?? []).map((point) => point.t), 1];
}

/** Directions of two edges at a shared end are parallel (within `tolerance` of the sine). */
function tangent(edge: ShapeTopology['edges'][number], atStart: boolean): Vec3 | null {
  const samples = edge.samples;
  const [near, far] =
    samples !== undefined && samples.length >= 2
      ? atStart
        ? [samples[0], samples[1]]
        : [samples[samples.length - 1], samples[samples.length - 2]]
      : atStart
        ? [edge.start, edge.mid]
        : [edge.end, edge.mid];
  if (near === undefined || far === undefined) return null;
  const vector: Vec3 = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
  const length = Math.hypot(...vector);
  return length < 1e-12 ? null : [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * Whether `edge` is the only edge of its tangent chain: no other edge of the shape continues it tangentially at either end. A law given by
 * relative position is read per picked edge by the kernel, so only such edges can be compared with their law end to end.
 */
export function isolatedEdge(topology: ShapeTopology, edge: number): boolean {
  const own = topology.edges[edge];
  if (own === undefined) return false;
  for (const atStart of [true, false]) {
    const point = atStart ? own.start : own.end;
    const ownTangent = tangent(own, atStart);
    for (const other of topology.edges) {
      if (other.index === edge || other.seam || other.degenerate) continue;
      for (const otherStart of [true, false]) {
        if (distance(point, otherStart ? other.start : other.end) > 1e-7 * Math.max(1, own.length)) continue;
        const otherTangent = tangent(other, otherStart);
        if (ownTangent === null || otherTangent === null) return false;
        const cross = Math.hypot(
          ownTangent[1] * otherTangent[2] - ownTangent[2] * otherTangent[1],
          ownTangent[2] * otherTangent[0] - ownTangent[0] * otherTangent[2],
          ownTangent[0] * otherTangent[1] - ownTangent[1] * otherTangent[0],
        );
        if (cross < 1e-3) return false;
      }
    }
  }
  return true;
}
