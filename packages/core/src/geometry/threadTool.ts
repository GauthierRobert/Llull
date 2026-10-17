/**
 * The modelled-thread groove of a hole (07 FTR FR-FTR-20): the trapezoid of the basic internal profile (`internalThreadForm`) in the axial plane,
 * screwed along the hole axis as one closed triangle mesh (`mesh` solid). The trapezoid keeps its axial orientation exactly (a pipe sweep twists a
 * non-circular section along a helix on both kernels) and its corners are exact (a smooth loft ring rounds them). A planar-faced tool is used
 * because OpenCascade booleans of a helical BSpline skin with the coaxial bore cylinder hang or drop an operand, while planar facets intersect
 * robustly. The inner edge reaches `INNER_MARGIN` x pitch inside the bore so the groove overlaps the bore void instead of sharing a surface.
 * @invariant the helix starts above the face and ends below the threaded depth by one groove width: no cap lies inside the material;
 *   ring radii are inflated by sqrt(step / sin step) so each facet wedge has the area of the circular sector it stands for (volume-faithful)
 * @failure bore radius at or above the major radius, groove wider than the pitch at its inner edge, no room for a turn, more than MAX_THREAD_TURNS turns -> null
 */

import type { HoleExtent, HoleSpec } from '../model/features';
import type { MeshData } from '../model/types';
import { type InternalThreadForm, internalThreadForm } from '../lib/threadForm';

/** Facet rings per helix turn. */
const RINGS_PER_TURN = 32;
const INNER_MARGIN = 0.05;
const MAX_FILL = 0.98;
/** Longest modelled thread (turns): past it the groove skin has too many faces for the OpenCascade booleans to stay responsive. */
export const MAX_THREAD_TURNS = 60;

/** Whether a bore of `boreRadius` carries the groove of `form`: below the major radius, and the groove at its inner edge narrower than the pitch. */
export function grooveFits(form: InternalThreadForm, boreRadius: number): boolean {
  if (!(boreRadius < form.majorRadius)) return false;
  const innerRadius = Math.min(form.minorRadius, boreRadius) - INNER_MARGIN * form.pitch;
  return form.widthAt(innerRadius) < MAX_FILL * form.pitch;
}

/** The groove's mesh in the hole frame (axis = local z, helix start at the origin height) and where that start lies. */
export interface ThreadGroove {
  readonly mesh: MeshData;
  /** Depth of the helix start below the face plane (document units; negative = above). */
  readonly startDepth: number;
}

type Corner = readonly [number, number, number];

/** Closed triangle mesh through `rings` of 4 corners each: walls between neighbours, 2-triangle caps on both ends. */
function skinMesh(rings: ReadonlyArray<ReadonlyArray<Corner>>): MeshData {
  const positions = rings.flatMap((ring) => ring.flatMap((point) => [...point]));
  const indices: number[] = [];
  const at = (ring: number, corner: number): number => ring * 4 + (corner % 4);
  for (let ring = 0; ring + 1 < rings.length; ring++)
    for (let corner = 0; corner < 4; corner++)
      indices.push(
        at(ring, corner),
        at(ring + 1, corner + 1),
        at(ring, corner + 1),
        at(ring, corner),
        at(ring + 1, corner),
        at(ring + 1, corner + 1),
      );
  const last = rings.length - 1;
  indices.push(at(0, 0), at(0, 1), at(0, 2), at(0, 0), at(0, 2), at(0, 3));
  indices.push(at(last, 0), at(last, 2), at(last, 1), at(last, 0), at(last, 3), at(last, 2));
  return { positions, indices };
}

/** `mesh` reflected in the xz plane (a left-handed screw from a right-handed one), triangles re-wound outward. */
function mirrored({ positions, indices }: MeshData): MeshData {
  return {
    positions: positions.map((value, index) => (index % 3 === 1 ? -value : value)),
    indices: indices.map((value, index) => (index % 3 === 0 ? value : (indices[index % 3 === 1 ? index + 1 : index - 1] as number))),
  };
}

/** Groove for `hole` (its `thread` must be modelled) cut by an `extent` whose material reaches `reach` below the face. */
export function threadGroove(hole: HoleSpec, extent: HoleExtent, reach: number): ThreadGroove | null {
  const { thread } = hole;
  if (thread?.modelled !== true || thread.pitch === undefined || thread.majorDiameter === undefined) return null;
  const form = internalThreadForm(thread.pitch, thread.majorDiameter);
  const boreRadius = hole.diameter / 2;
  if (!grooveFits(form, boreRadius)) return null;
  const innerRadius = Math.min(form.minorRadius, boreRadius) - INNER_MARGIN * form.pitch;
  const innerWidth = form.widthAt(innerRadius);
  const outerWidth = form.widthAt(form.majorRadius);
  const topCenter = innerWidth;
  const bottomCenter =
    extent.kind === 'through_all'
      ? -reach - innerWidth
      : innerWidth / 2 + INNER_MARGIN * form.pitch - Math.min(thread.depth ?? extent.depth, extent.depth);
  const turns = (topCenter - bottomCenter) / form.pitch;
  if (!(turns > 0.5) || turns > MAX_THREAD_TURNS) return null;
  const corners = [
    [innerRadius, -innerWidth / 2],
    [form.majorRadius, -outerWidth / 2],
    [form.majorRadius, outerWidth / 2],
    [innerRadius, innerWidth / 2],
  ] as const;
  const ringCount = Math.max(2, Math.ceil(turns * RINGS_PER_TURN) + 1);
  const step = (2 * Math.PI * turns) / (ringCount - 1);
  const inflate = Math.sqrt(step / Math.sin(step));
  const rings = Array.from({ length: ringCount }, (_, index): Corner[] => {
    const angle = (2 * Math.PI * turns * index) / (ringCount - 1);
    const lift = (form.pitch * angle) / (2 * Math.PI);
    return corners.map(
      ([radius, offset]): Corner => [radius * inflate * Math.cos(angle), radius * inflate * Math.sin(angle), lift + offset],
    );
  });
  const right = skinMesh(rings);
  const mesh = thread.handedness === 'left' ? mirrored(right) : right;
  return { mesh, startDepth: -bottomCenter };
}
