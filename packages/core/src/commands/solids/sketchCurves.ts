/**
 * @layer core/commands
 * 2D sketch entities → exact curve chains: one closed loop for profiles (extrude / revolve /
 * sweep sections) or an open 3D path for sweeps. Pure helpers, no document mutation.
 */

import type { CurveSegment } from '../../model/curve';
import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { add3, distance3, sub3 } from '../../lib/vec3';
import {
  JOINT_TOLERANCE,
  catmullRomBeziers,
  chainIssue,
  mapSegment,
  reverseChain,
  sampleProfile,
} from '../../geometry/curveSegments';
import { MAX_PROFILE_POINTS } from '../limits';

/** Cubic Bézier handle length of a quarter ellipse (max radial error ≈ 0.03 %). */
const QUARTER_KAPPA = 0.5522847498;

/** Closed exact boundary in sketch coordinates and its polygon tessellation. */
export interface SketchLoop {
  readonly curves: CurveSegment<Vec2>[];
  readonly profile: Vec2[];
  /** Position and rotation of the first sketch entity (the loop's frame). */
  readonly origin: Vec3;
  readonly rotation: Vec3;
  /** The first entity's position expressed in its own plane (add to get plane coordinates). */
  readonly planeOffset: Vec2;
}

const line = (a: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'line', points: [a, b] });

function polar(center: Vec2, radius: number, angle: number): Vec2 {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

function ellipseCurves(center: Vec2, rx: number, ry: number): CurveSegment<Vec2>[] {
  const at = (x: number, y: number): Vec2 => [center[0] + x, center[1] + y];
  const quarters: Array<[number, number, number, number]> = [
    [1, 0, 0, 1],
    [0, 1, -1, 0],
    [-1, 0, 0, -1],
    [0, -1, 1, 0],
  ];
  return quarters.map(([ax, ay, bx, by]) => ({
    type: 'bezier',
    points: [
      at(ax * rx, ay * ry),
      at(ax * rx + bx * rx * QUARTER_KAPPA, ay * ry + by * ry * QUARTER_KAPPA),
      at(bx * rx + ax * rx * QUARTER_KAPPA, by * ry + ay * ry * QUARTER_KAPPA),
      at(bx * rx, by * ry),
    ],
  }));
}

/**
 * Exact curves of one 2D entity in its local plane, and whether they already close.
 * @failure kinds without a curve (point, text, dimension, solids) -> null
 */
export function entityCurves(
  entity: Entity,
): { curves: CurveSegment<Vec2>[]; closed: boolean } | null {
  switch (entity.kind) {
    case 'line':
      return { curves: [line(entity.start, entity.end)], closed: false };
    case 'arc': {
      let sweep = entity.endAngle - entity.startAngle;
      while (sweep <= 0) sweep += 2 * Math.PI;
      const { center, radius, startAngle } = entity;
      return {
        curves: [
          {
            type: 'arc',
            points: [
              polar(center, radius, startAngle),
              polar(center, radius, startAngle + sweep / 2),
              polar(center, radius, startAngle + sweep),
            ],
          },
        ],
        closed: false,
      };
    }
    case 'circle': {
      const { center, radius } = entity;
      const p = (quarter: number): Vec2 => polar(center, radius, (quarter * Math.PI) / 2);
      return {
        curves: [
          { type: 'arc', points: [p(0), p(1), p(2)] },
          { type: 'arc', points: [p(2), p(3), p(0)] },
        ],
        closed: true,
      };
    }
    case 'ellipse':
      return { curves: ellipseCurves(entity.center, entity.radiusX, entity.radiusY), closed: true };
    case 'rectangle': {
      const corners: Vec2[] = [
        [0, 0],
        [entity.width, 0],
        [entity.width, entity.height],
        [0, entity.height],
      ];
      return { curves: corners.map((c, i) => line(c, corners[(i + 1) % 4] as Vec2)), closed: true };
    }
    case 'polyline': {
      const pts = entity.points;
      const count = entity.closed ? pts.length : pts.length - 1;
      const curves = Array.from({ length: Math.max(0, count) }, (_, i) =>
        line(pts[i] as Vec2, pts[(i + 1) % pts.length] as Vec2),
      ).filter(({ points: [a, b] }) => Math.hypot(b[0] - a[0], b[1] - a[1]) > JOINT_TOLERANCE);
      return { curves, closed: entity.closed };
    }
    case 'spline':
      return entity.points.length < 2
        ? { curves: [], closed: entity.closed }
        : { curves: catmullRomBeziers(entity.points, entity.closed), closed: entity.closed };
    default:
      return null;
  }
}

/** Inverse of the intrinsic XYZ Euler rotation (Rx·Ry·Rz)⁻¹ = Rz⁻¹·Ry⁻¹·Rx⁻¹. */
function unrotate(v: Vec3, [rx, ry, rz]: Vec3): Vec3 {
  const o: Vec3 = [0, 0, 0];
  return applyEulerXYZ(applyEulerXYZ(applyEulerXYZ(v, o, [-rx, 0, 0]), o, [0, -ry, 0]), o, [
    0,
    0,
    -rz,
  ]);
}

const firstPoint = (chain: ReadonlyArray<CurveSegment<Vec2>>): Vec2 | undefined =>
  chain[0]?.points[0];
const lastPoint = (chain: ReadonlyArray<CurveSegment<Vec2>>): Vec2 | undefined => {
  const last = chain[chain.length - 1];
  return last?.points[last.points.length - 1];
};
const near = (a: Vec2 | undefined, b: Vec2 | undefined): boolean =>
  a !== undefined && b !== undefined && distance3([...a, 0], [...b, 0]) <= JOINT_TOLERANCE;

/** `piece` with its first point set exactly to `at` (joints within tolerance become shared). */
function snapStart(piece: CurveSegment<Vec2>[], at: Vec2): CurveSegment<Vec2>[] {
  const [first, ...rest] = piece;
  if (first === undefined) return piece;
  const points = [at, ...first.points.slice(1)];
  return [{ type: first.type, points } as unknown as CurveSegment<Vec2>, ...rest];
}

function snapEnd(segment: CurveSegment<Vec2>, at: Vec2): CurveSegment<Vec2> {
  const points = [...segment.points.slice(0, -1), at];
  return { type: segment.type, points } as unknown as CurveSegment<Vec2>;
}

/** Pieces joined end-to-start in any order/direction; null when some piece never connects. */
function joinPieces(pieces: CurveSegment<Vec2>[][]): CurveSegment<Vec2>[] | null {
  const [first, ...rest] = pieces;
  if (first === undefined) return null;
  const chain = [...first];
  const remaining = [...rest];
  while (remaining.length > 0) {
    const tail = lastPoint(chain);
    const index = remaining.findIndex(
      (piece) => near(firstPoint(piece), tail) || near(lastPoint(piece), tail),
    );
    if (index < 0) return null;
    const [piece] = remaining.splice(index, 1) as [CurveSegment<Vec2>[]];
    const oriented = near(firstPoint(piece), tail) ? piece : reverseChain(piece);
    chain.push(...snapStart(oriented, tail as Vec2));
  }
  const head = firstPoint(chain);
  const last = chain[chain.length - 1];
  if (head !== undefined && last !== undefined && near(lastPoint(chain), head))
    chain[chain.length - 1] = snapEnd(last, head);
  return chain;
}

/**
 * Closed loop from coplanar 2D entities (one closed shape, or open pieces that join end to end).
 * Coordinates are in the first entity's plane, relative to its position.
 * @failure missing / non-curve entity, different planes, gaps, not closed, too many points -> message
 */
export function sketchLoop(doc: CadDocument, ids: readonly string[]): SketchLoop | string {
  const entities = ids.map((id) => doc.entities[id]);
  const first = entities[0];
  if (first === undefined)
    return ids.length === 0 ? 'no profile ids given' : `no entity "${ids[0]}"`;
  const pieces: CurveSegment<Vec2>[][] = [];
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity === undefined) return `no entity "${ids[i]}"`;
    const own = entityCurves(entity);
    if (own === null) return `entity "${entity.id}" (kind="${entity.kind}") is not a 2D curve`;
    if (entity.rotation.some((angle, k) => Math.abs(angle - (first.rotation[k] ?? 0)) > 1e-9))
      return `entity "${entity.id}" is not in the same work plane as "${first.id}" (different rotation)`;
    const [dx, dy, dz] = unrotate(sub3(entity.position, first.position), first.rotation);
    if (Math.abs(dz) > JOINT_TOLERANCE)
      return `entity "${entity.id}" is not in the same work plane as "${first.id}" (offset ${dz.toFixed(4)} off the plane)`;
    pieces.push(own.curves.map((s) => mapSegment(s, ([x, y]): Vec2 => [x + dx, y + dy])));
  }
  const curves = joinPieces(pieces);
  if (curves === null) return 'the entities do not join end to end into one chain';
  const issue = chainIssue(curves, true);
  if (issue !== null)
    return /zero length|collinear/.test(issue) ? `profile encloses no area (${issue})` : issue;
  const profile = sampleProfile(curves);
  if (profile.length < 3) return 'the loop has fewer than 3 distinct points';
  if (profile.length > MAX_PROFILE_POINTS)
    return `the loop tessellates to ${profile.length} points, exceeding MAX_PROFILE_POINTS (${MAX_PROFILE_POINTS})`;
  const [ox, oy] = unrotate(first.position, first.rotation);
  return {
    curves,
    profile,
    origin: first.position,
    rotation: first.rotation,
    planeOffset: [ox, oy],
  };
}

/**
 * World-space path of one open 2D entity (line, arc, open polyline or spline) placed by its own
 * position and rotation.
 * @failure missing / closed / non-curve entity -> message
 */
export function sketchPath(doc: CadDocument, id: string): CurveSegment<Vec3>[] | string {
  const entity = doc.entities[id];
  if (entity === undefined) return `no entity "${id}"`;
  const own = entityCurves(entity);
  if (own === null) return `entity "${id}" (kind="${entity.kind}") is not a 2D curve`;
  if (own.closed) return `entity "${id}" is closed; a sweep path must be open`;
  const toWorld = ([x, y]: Vec2): Vec3 =>
    add3(applyEulerXYZ([x, y, 0], [0, 0, 0], entity.rotation), entity.position);
  return own.curves.map((segment) => mapSegment(segment, toWorld));
}
