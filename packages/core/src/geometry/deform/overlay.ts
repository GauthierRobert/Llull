/** What the deformation overlays of the viewport draw (01 DEF M4): the frame, the region slab, the lattice and its displaced net, the base and target curves of a flow, the sheets of a flow on a surface. World coordinates, document units. */

import type { DeformLaw, DeformRegion } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { add3 } from '../../lib/vec3';
import { type LocalFrame, toWorld } from './frame';
import { fromBoxCoordinates, restPosition } from './lattice';

interface FrameOverlay {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
  /** Length of the drawn axes, document units. */
  readonly length: number;
}

interface RegionOverlay {
  readonly start: number;
  readonly end: number;
  readonly infinite: boolean;
  readonly falloff: DeformRegion['falloff'];
  /** The centres of the start and end planes on the frame axis (world). */
  readonly startCentre: Vec3;
  readonly endCentre: Vec3;
  /** Half the size of the drawn planes, document units. */
  readonly radius: number;
}

interface LatticeOverlay {
  readonly degrees: readonly [number, number, number];
  /** Null: a Bernstein lattice; else the B-spline degrees. */
  readonly splineDegrees: readonly [number, number, number] | null;
  /** True: the box has its own axes (an oriented box). */
  readonly oriented: boolean;
  /** Control points at rest and displaced by their offsets, i-major then j then k (world). */
  readonly rest: Vec3[];
  readonly moved: Vec3[];
  /** The eight corners of the box, in the order of (i, j, k) = (0|1, 0|1, 0|1). */
  readonly box: Vec3[];
  /** Control points with a non-zero offset. */
  readonly displaced: number;
}

interface FlowOverlay {
  /** The stations of the target curve (world), and of the base curve when the flow has one. */
  readonly target: Vec3[];
  readonly base: Vec3[] | null;
}

interface SheetOverlay {
  readonly nx: number;
  readonly ny: number;
  /** The nodes of the target sheet and of the base sheet (world, i-major) the flow tabulates; the base is null for a base plane. */
  readonly target: Vec3[];
  readonly base: Vec3[] | null;
}

export interface DeformOverlayData {
  readonly law: DeformLaw['kind'];
  readonly frame: FrameOverlay;
  readonly region: RegionOverlay | null;
  readonly lattice: LatticeOverlay | null;
  readonly flow: FlowOverlay | null;
  readonly sheet: SheetOverlay | null;
}

/** Points of a table of `per` numbers per station whose first three are a point in the local frame. */
function tablePoints(frame: LocalFrame, numbers: ReadonlyArray<number>, per: number): Vec3[] {
  return Array.from({ length: Math.floor(numbers.length / per) }, (_, i) =>
    toWorld(frame, [numbers[per * i] as number, numbers[per * i + 1] as number, numbers[per * i + 2] as number]),
  );
}

function latticeOverlay(law: Extract<DeformLaw, { kind: 'lattice' }>, frame: LocalFrame): LatticeOverlay {
  const [l, m, n] = law.degrees;
  const world = (c: Vec3): Vec3 => toWorld(frame, fromBoxCoordinates(law, c));
  const at = (i: number, j: number, k: number): Vec3 => {
    const t = [restPosition(law, 0, i), restPosition(law, 1, j), restPosition(law, 2, k)];
    const along = (a: 0 | 1 | 2): number => law.box.min[a] + (t[a] as number) * (law.box.max[a] - law.box.min[a]);
    return [along(0), along(1), along(2)];
  };
  const offsets = new Map<number, Vec3>();
  for (const { index, delta } of law.offsets) {
    const key = (index[0] * (m + 1) + index[1]) * (n + 1) + index[2];
    const known = offsets.get(key) ?? [0, 0, 0];
    offsets.set(key, add3(known, delta));
  }
  const rest: Vec3[] = [];
  const moved: Vec3[] = [];
  let displaced = 0;
  for (let i = 0; i <= l; i++)
    for (let j = 0; j <= m; j++)
      for (let k = 0; k <= n; k++) {
        // the offsets are displacements in frame coordinates, added to the frame position of the rest point
        const local = fromBoxCoordinates(law, at(i, j, k));
        const delta = offsets.get((i * (m + 1) + j) * (n + 1) + k);
        rest.push(toWorld(frame, local));
        moved.push(toWorld(frame, delta === undefined ? local : add3(local, delta)));
        if (delta !== undefined && (delta[0] !== 0 || delta[1] !== 0 || delta[2] !== 0)) displaced += 1;
      }
  const corner = (a: number, b: number, c: number): Vec3 =>
    world([
      a === 0 ? law.box.min[0] : law.box.max[0],
      b === 0 ? law.box.min[1] : law.box.max[1],
      c === 0 ? law.box.min[2] : law.box.max[2],
    ]);
  const box: Vec3[] = [];
  for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) box.push(corner(a, b, c));
  return { degrees: law.degrees, splineDegrees: law.splineDegrees ?? null, oriented: law.axes !== undefined, rest, moved, box, displaced };
}

/**
 * The overlay data of a deform node. `extent` is the half-diagonal of the body bounds (the length the frame axes are drawn at), `lateral` the reach of the body from the frame axis (the half size of the region planes).
 */
export function buildDeformOverlay(
  law: DeformLaw,
  region: DeformRegion | undefined,
  frame: LocalFrame,
  extent: number,
  lateral: number,
): DeformOverlayData {
  const flow: FlowOverlay | null =
    law.kind === 'flowCurve'
      ? { target: tablePoints(frame, law.stations, 12), base: law.base === undefined ? null : tablePoints(frame, law.base.stations, 12) }
      : null;
  const sheet: SheetOverlay | null =
    law.kind === 'flowSurface'
      ? {
          nx: law.nx,
          ny: law.ny,
          target: tablePoints(frame, law.nodes, 6),
          base: law.baseNodes === undefined ? null : tablePoints(frame, law.baseNodes, 6),
        }
      : null;
  return {
    law: law.kind,
    frame: { origin: frame.origin, x: frame.x, y: frame.y, z: frame.z, length: 0.5 * extent },
    region:
      region === undefined
        ? null
        : {
            start: region.start,
            end: region.end,
            infinite: region.infinite === true,
            falloff: region.falloff,
            startCentre: toWorld(frame, [0, 0, region.start]),
            endCentre: toWorld(frame, [0, 0, region.end]),
            radius: lateral,
          },
    lattice: law.kind === 'lattice' ? latticeOverlay(law, frame) : null,
    flow,
    sheet,
  };
}
