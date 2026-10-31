// Pure data-to-geometry mapping of the deformation overlays: the `deform_overlay` answer (world coordinates) as flat xyz arrays of line-segment
// pairs, ready for a LineSegments geometry. Presentation only: every point comes from the command, nothing is derived from the document here.

import type { Vec3 } from '@core/model/types';
import { REFERENCE_FIELDS, type ReferenceKind } from '@core/geometry/deform/referenceShape';
import type { ReferenceDraft } from '@ui/store/deformOverlayStore';

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const isPoints = (value: unknown): value is Vec3[] => Array.isArray(value) && value.every(isVec3);

export interface DeformOverlayView {
  readonly frame: { origin: Vec3; x: Vec3; y: Vec3; z: Vec3; length: number };
  readonly region: { startCentre: Vec3; endCentre: Vec3; radius: number; infinite: boolean } | null;
  readonly lattice: { degrees: readonly [number, number, number]; rest: Vec3[]; moved: Vec3[]; box: Vec3[] } | null;
  readonly flow: { target: Vec3[]; base: Vec3[] | null } | null;
  readonly sheet: { nx: number; ny: number; target: Vec3[]; base: Vec3[] | null } | null;
  readonly reference: Vec3[][] | null;
}

/** The overlay of a `deform_overlay` answer; null when the data is not that shape. */
export function parseDeformOverlay(data: unknown): DeformOverlayView | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const frame = d['frame'] as Record<string, unknown> | undefined;
  if (frame === undefined || !isVec3(frame['origin']) || !isVec3(frame['x']) || !isVec3(frame['y']) || !isVec3(frame['z'])) return null;
  const length = frame['length'];
  if (typeof length !== 'number' || !(length > 0)) return null;
  const region = d['region'] as Record<string, unknown> | null | undefined;
  const lattice = d['lattice'] as Record<string, unknown> | null | undefined;
  const flow = d['flow'] as Record<string, unknown> | null | undefined;
  const sheet = d['sheet'] as Record<string, unknown> | null | undefined;
  const reference = d['reference'];
  return {
    frame: { origin: frame['origin'], x: frame['x'], y: frame['y'], z: frame['z'], length },
    region:
      region && isVec3(region['startCentre']) && isVec3(region['endCentre']) && typeof region['radius'] === 'number'
        ? {
            startCentre: region['startCentre'],
            endCentre: region['endCentre'],
            radius: region['radius'],
            infinite: region['infinite'] === true,
          }
        : null,
    lattice:
      lattice && isPoints(lattice['rest']) && isPoints(lattice['moved']) && isPoints(lattice['box']) && Array.isArray(lattice['degrees'])
        ? { degrees: lattice['degrees'] as [number, number, number], rest: lattice['rest'], moved: lattice['moved'], box: lattice['box'] }
        : null,
    flow: flow && isPoints(flow['target']) ? { target: flow['target'], base: isPoints(flow['base']) ? flow['base'] : null } : null,
    sheet:
      sheet && isPoints(sheet['target']) && typeof sheet['nx'] === 'number' && typeof sheet['ny'] === 'number'
        ? { nx: sheet['nx'], ny: sheet['ny'], target: sheet['target'], base: isPoints(sheet['base']) ? sheet['base'] : null }
        : null,
    reference: Array.isArray(reference) && reference.every(isPoints) ? (reference as Vec3[][]) : null,
  };
}

/** Flat segment pairs accumulated from point pairs. */
class Pairs {
  readonly out: number[] = [];
  add(a: Vec3, b: Vec3): void {
    this.out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  chain(points: ReadonlyArray<Vec3>): void {
    for (let i = 0; i + 1 < points.length; i++) this.add(points[i] as Vec3, points[i + 1] as Vec3);
  }
  array(): Float32Array {
    return Float32Array.from(this.out);
  }
}

const at = (origin: Vec3, a: Vec3, s: number, b: Vec3, t: number): Vec3 => [
  origin[0] + a[0] * s + b[0] * t,
  origin[1] + a[1] * s + b[1] * t,
  origin[2] + a[2] * s + b[2] * t,
];

/** The three axes of the frame from its origin. */
export function frameSegments(frame: DeformOverlayView['frame']): { x: Float32Array; y: Float32Array; z: Float32Array } {
  const axis = (direction: Vec3): Float32Array => {
    const pairs = new Pairs();
    pairs.add(frame.origin, [
      frame.origin[0] + direction[0] * frame.length,
      frame.origin[1] + direction[1] * frame.length,
      frame.origin[2] + direction[2] * frame.length,
    ]);
    return pairs.array();
  };
  return { x: axis(frame.x), y: axis(frame.y), z: axis(frame.z) };
}

/** The squares at the region ends (across the frame x and y, half the radius side), their four joining edges, and for an infinite region the axis past both ends. */
export function regionSegments(
  region: NonNullable<DeformOverlayView['region']>,
  frame: DeformOverlayView['frame'],
): { slab: Float32Array; axis: Float32Array } {
  const slab = new Pairs();
  const corners = (centre: Vec3): Vec3[] =>
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([s, t]) => at(centre, frame.x, (s as number) * region.radius, frame.y, (t as number) * region.radius));
  const [start, end] = [corners(region.startCentre), corners(region.endCentre)];
  for (let i = 0; i < 4; i++) {
    slab.add(start[i] as Vec3, start[(i + 1) % 4] as Vec3);
    slab.add(end[i] as Vec3, end[(i + 1) % 4] as Vec3);
    slab.add(start[i] as Vec3, end[i] as Vec3);
  }
  const axis = new Pairs();
  if (region.infinite) {
    const direction = (a: Vec3, b: Vec3): Vec3 => {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
      return [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l];
    };
    const along = direction(region.startCentre, region.endCentre);
    const reach = (centre: Vec3, sign: number): Vec3 => [
      centre[0] + sign * along[0] * region.radius,
      centre[1] + sign * along[1] * region.radius,
      centre[2] + sign * along[2] * region.radius,
    ];
    axis.add(reach(region.startCentre, -1), reach(region.endCentre, 1));
  }
  return { slab: slab.array(), axis: axis.array() };
}

/** The lines of a control net: every point joined to its next one along i, j and k (i-major, then j, then k). */
export function netSegments(points: ReadonlyArray<Vec3>, degrees: readonly [number, number, number]): Float32Array {
  const [l, m, n] = degrees;
  const pairs = new Pairs();
  const id = (i: number, j: number, k: number): number => (i * (m + 1) + j) * (n + 1) + k;
  if (points.length !== (l + 1) * (m + 1) * (n + 1)) return pairs.array();
  for (let i = 0; i <= l; i++)
    for (let j = 0; j <= m; j++)
      for (let k = 0; k <= n; k++) {
        const here = points[id(i, j, k)] as Vec3;
        if (i < l) pairs.add(here, points[id(i + 1, j, k)] as Vec3);
        if (j < m) pairs.add(here, points[id(i, j + 1, k)] as Vec3);
        if (k < n) pairs.add(here, points[id(i, j, k + 1)] as Vec3);
      }
  return pairs.array();
}

/** The twelve edges of a box given its corners in the order of (a, b, c) = (0|1, 0|1, 0|1). */
export function boxSegments(corners: ReadonlyArray<Vec3>): Float32Array {
  const pairs = new Pairs();
  if (corners.length !== 8) return pairs.array();
  for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) if ((c & bit) === 0) pairs.add(corners[c] as Vec3, corners[c | bit] as Vec3);
  return pairs.array();
}

/** The polyline through `points`. */
export function chainSegments(points: ReadonlyArray<Vec3>): Float32Array {
  const pairs = new Pairs();
  pairs.chain(points);
  return pairs.array();
}

/** Several polylines. */
export function chainsSegments(chains: ReadonlyArray<ReadonlyArray<Vec3>>): Float32Array {
  const pairs = new Pairs();
  for (const chain of chains) pairs.chain(chain);
  return pairs.array();
}

/** The grid lines of an nx by ny table of nodes (i-major): the sheet the flow tabulates. */
export function gridSegments(nodes: ReadonlyArray<Vec3>, nx: number, ny: number): Float32Array {
  const pairs = new Pairs();
  if (nodes.length !== nx * ny) return pairs.array();
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      if (i + 1 < nx) pairs.add(nodes[i * ny + j] as Vec3, nodes[(i + 1) * ny + j] as Vec3);
      if (j + 1 < ny) pairs.add(nodes[i * ny + j] as Vec3, nodes[i * ny + j + 1] as Vec3);
    }
  return pairs.array();
}

const NUMBER_FIELDS = new Set(['majorRadius', 'minorRadius', 'radius', 'halfAngleDeg', 'rate', 'offset']);
const VECTOR_FIELDS = new Set(['center', 'point', 'apex', 'axis', 'semiAxes', 'normal', 'reference']);
export const REFERENCE_KINDS = Object.keys(REFERENCE_FIELDS) as ReferenceKind[];

/** The fields to type for a reference kind, with how they are written. */
export function referenceFields(kind: string): ReadonlyArray<{ name: string; hint: string }> {
  const names = REFERENCE_FIELDS[kind as ReferenceKind];
  if (names === undefined) return [];
  const withOffset = kind === 'helicoid' ? [...names, 'offset'] : names;
  return withOffset.map((name) => ({
    name,
    hint: VECTOR_FIELDS.has(name) ? 'x y z' : name === 'radii' ? 'a b' : NUMBER_FIELDS.has(name) ? 'number' : '',
  }));
}

const numbers = (text: string | undefined): number[] =>
  (text ?? '')
    .split(/[\s,;]+/)
    .filter((part) => part !== '')
    .map(Number);

/** The compareTo parameter of a draft, or null while a required field is empty or not a number. */
export function referenceParams(draft: ReferenceDraft | null): Record<string, unknown> | null {
  if (draft === null) return null;
  const required = REFERENCE_FIELDS[draft.kind as ReferenceKind];
  if (required === undefined) return null;
  const params: Record<string, unknown> = { kind: draft.kind };
  const wanted = draft.kind === 'helicoid' ? [...required, 'offset'] : required;
  for (const name of wanted) {
    const parts = numbers(draft.fields[name]);
    const size = VECTOR_FIELDS.has(name) ? 3 : name === 'radii' ? 2 : 1;
    const complete = parts.length === size && parts.every(Number.isFinite);
    if (!complete) {
      if (name === 'offset') continue;
      return null;
    }
    params[name] = size === 1 ? parts[0] : parts;
  }
  return params;
}
