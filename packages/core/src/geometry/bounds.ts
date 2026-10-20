import type { CadDocument, DimensionEntity, Entity, InstanceEntity, TextEntity, Vec3 } from '../model/types';
import { instanceToWorld } from './instanceTransform';
import { pointsExtent, tupleExtent } from '../lib/extent';
import { ORIGIN, add3, vec3At } from '../lib/vec3';
import { poleExtent } from './nurbsCurve';
import { surfacePoleExtent } from './nurbsSurface';
import { sweepTriangles } from './sweep';
import { loftTriangles } from './loft';
import { subdivisionTriangles } from './subdivision';
import { revolutionAxisIndex } from './revolution';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';

/** World-space axis-aligned bounding box. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
  /**
   * True when the entity had non-zero rotation and the bounds were computed by rotating the entity's local OBB corners into world space
   * (i.e. the AABB wraps the actual rotated geometry). Absent / false for unrotated entities — those bounds are identical to the previous
   * behaviour.
   */
  oriented?: true;
}

/** Min/max of a flat xyz position array (`[x0, y0, z0, x1, ...]`); needs at least one full triple. */
function positionsExtent(positions: readonly number[]): { min: Vec3; max: Vec3 } {
  const { min, max } = tupleExtent(positions, 3);
  return { min: vec3At(min, 0), max: vec3At(max, 0) };
}

const bounds = (min: Vec3, max: Vec3): Bounds => ({ min, max });

/** Axis-aligned box centered on the origin. */
const centered = (x: number, y: number, z: number): Bounds => bounds([-x, -y, -z], [x, y, z]);

/** Width of a glyph as a fraction of the text height (monospace estimate). */
export const GLYPH_WIDTH_RATIO = 0.6;
/** Distance between consecutive text lines as a fraction of the text height. */
const LINE_SPACING_RATIO = 1.2;

/**
 * Local AABB of a text block as the viewport lays it out: the longest line sets the width, `anchor` (left by default) places that width
 * relative to `position`, lines stack at 1.2 em and the whole block is centred vertically on `position` (drei `anchorY="middle"`). Single
 * source of the text layout estimate for core bounds and UI picking.
 */
export function textLocalBounds(e: TextEntity): Bounds {
  const lines = e.content.split('\n');
  const width = Math.max(...lines.map((line) => line.length)) * e.height * GLYPH_WIDTH_RATIO;
  const blockHeight = e.height * (1 + (lines.length - 1) * LINE_SPACING_RATIO);
  const left = e.anchor === 'center' ? -width / 2 : e.anchor === 'right' ? -width : 0;
  return bounds([left, -blockHeight / 2, 0], [left + width, blockHeight / 2, 0]);
}

const heavyLocalBounds = new WeakMap<Entity, Bounds>();

/** Memoize `compute` per entity object (entities are immutable): mesh vertices / tessellated sweeps are not re-walked per query. */
function memoLocal(e: Entity, compute: () => Bounds): Bounds {
  const cached = heavyLocalBounds.get(e);
  if (cached !== undefined) return cached;
  const result = compute();
  heavyLocalBounds.set(e, result);
  return result;
}

/** Local-space AABB of a `mesh`: its vertices, which `position` / `rotation` place like any other entity's local geometry. */
function meshLocalBounds(e: Extract<Entity, { kind: 'mesh' }>): Bounds {
  const p = e.mesh.positions;
  if (p.length < 3) return bounds(ORIGIN, ORIGIN);
  const { min, max } = positionsExtent(p);
  return bounds(min, max);
}

/** Local-space AABB of a sweep or loft: its tessellated surface around the local origin. */
function sweepLocalBounds(e: Extract<Entity, { kind: 'sweep' | 'loft' | 'subdivision' }>): Bounds {
  const corners = (e.kind === 'sweep' ? sweepTriangles(e) : e.kind === 'loft' ? loftTriangles(e) : subdivisionTriangles(e)).flat();
  if (corners.length === 0) return bounds(ORIGIN, ORIGIN);
  const { min, max } = positionsExtent(corners.flat());
  return bounds(min, max);
}

/**
 * [min,max] of the two radial coordinates (r·cosθ, r·sinθ) over θ ∈ [0, angle] for r ∈ [rMin, rMax]. Extremes sit at the arc ends and at
 * the quarter turns inside the sweep; a full turn gives the symmetric ±max|r| square.
 */
function arcExtent(rMin: number, rMax: number, angle: number): [[number, number], [number, number]] {
  const sweep = Math.min(angle, 2 * Math.PI);
  const thetas = [0, sweep];
  for (let k = 1; (k * Math.PI) / 2 < sweep - 1e-9; k++) thetas.push((k * Math.PI) / 2);
  const xs = thetas.flatMap((t) => [rMin * Math.cos(t), rMax * Math.cos(t)]);
  const ys = thetas.flatMap((t) => [rMin * Math.sin(t), rMax * Math.sin(t)]);
  const snap = (n: number): number => (Math.abs(n) < 1e-12 ? 0 : n);
  return [
    [snap(Math.min(...xs)), snap(Math.max(...xs))],
    [snap(Math.min(...ys)), snap(Math.max(...ys))],
  ];
}

/**
 * AABB of one entity in its own frame (before `rotation` / `position`), matching how the viewport places each kind. Mesh positions are
 * world-space, so their local bounds are relative to `position`.
 */
export function localBounds(e: Entity): Bounds {
  switch (e.kind) {
    case 'box':
      return centered(e.size[0] / 2, e.size[1] / 2, e.size[2] / 2);
    case 'cylinder':
      // Z-up: axis along Z, centered at position (matches render.ts / export.ts).
      return centered(e.radius, e.radius, e.height / 2);
    case 'sphere':
      return centered(e.radius, e.radius, e.radius);
    case 'extrusion': {
      // ExtrudeGeometry extrudes along +Z from the profile plane.
      const { minX, minY, maxX, maxY } = pointsExtent(e.profile);
      return bounds([minX, minY, 0], [maxX, maxY, e.depth]);
    }
    case 'mesh':
      return memoLocal(e, () => meshLocalBounds(e));
    case 'cone':
      // Base circle in XY; apex at +height in Z.
      return bounds([-e.radius, -e.radius, 0], [e.radius, e.radius, e.height]);
    case 'torus': {
      // Ring in XY: outer extent is ringRadius+tubeRadius; tube extends ±tubeRadius in Z.
      const outer = e.ringRadius + e.tubeRadius;
      return centered(outer, outer, e.tubeRadius);
    }
    case 'wedge':
      // Lower-front-left corner at position; extends +X/+Y/+Z by size.
      return bounds(ORIGIN, e.size);
    case 'pyramid':
      return bounds([-e.baseWidth / 2, -e.baseDepth / 2, 0], [e.baseWidth / 2, e.baseDepth / 2, e.height]);
    case 'sweep':
    case 'loft':
    case 'subdivision':
      return memoLocal(e, () => sweepLocalBounds(e));
    case 'revolution': {
      // Radial extent follows the swept arc (from +X, counter-clockwise); axial extent from the profile.
      const radii = e.profile.map(([r]) => r);
      const minAxial = Math.min(...e.profile.map(([, y]) => y));
      const maxAxial = Math.max(...e.profile.map(([, y]) => y));
      const [u, v] = arcExtent(Math.min(...radii), Math.max(...radii), e.angle);
      const axial = revolutionAxisIndex(e.axis);
      if (axial === 2) return bounds([u[0], v[0], minAxial], [u[1], v[1], maxAxial]);
      if (axial === 1) return bounds([u[0], minAxial, v[0]], [u[1], maxAxial, v[1]]);
      return bounds([minAxial, u[0], v[0]], [maxAxial, u[1], v[1]]);
    }
    case 'line': {
      const { minX, minY, maxX, maxY } = pointsExtent([e.start, e.end]);
      return bounds([minX, minY, 0], [maxX, maxY, 0]);
    }
    case 'polyline':
    case 'spline': {
      const { minX, minY, maxX, maxY } = pointsExtent(e.points);
      return bounds([minX, minY, 0], [maxX, maxY, 0]);
    }
    case 'arc':
    case 'circle':
      // Conservative: full center±radius box (arcs are not angle-trimmed here).
      return bounds([e.center[0] - e.radius, e.center[1] - e.radius, 0], [e.center[0] + e.radius, e.center[1] + e.radius, 0]);
    case 'rectangle':
    case 'image':
      // Origin at lower-left; extends +X (width), +Y (height).
      return bounds(ORIGIN, [e.width, e.height, 0]);
    case 'ellipse':
      return bounds([e.center[0] - e.radiusX, e.center[1] - e.radiusY, 0], [e.center[0] + e.radiusX, e.center[1] + e.radiusY, 0]);
    case 'text':
      return textLocalBounds(e);
    case 'dimension': {
      // No own geometry: a small box sized by the witness-line offset.
      const ext = e.offset ?? 5;
      return bounds([-ext, -ext, 0], [ext, ext, 0]);
    }
    case 'nurbs_surface': {
      const { min, max } = surfacePoleExtent(e.surface);
      return bounds(min, max);
    }
    case 'nurbs_curve': {
      const { min, max } = poleExtent(e.curve);
      return bounds(min, max);
    }
    case 'point':
    case 'instance':
      // Instances need the document for real bounds: use `instanceBoundsFromDoc`.
      return bounds(ORIGIN, ORIGIN);
  }
}

/** World-space AABB of one entity, matching how the viewport places each kind. */
export function entityBounds(e: Entity): Bounds {
  const { min, max } = localBounds(e);
  return bounds(add3(e.position, min), add3(e.position, max));
}

/** Local-space points whose rotated hull bounds `e`: cone/pyramid base corners + apex, otherwise the 8 local AABB corners. */
function localEntityCorners(e: Entity): Vec3[] {
  if (e.kind === 'mesh' && (e.mesh.positions.length < 9 || e.mesh.positions.length % 3 !== 0)) return [[0, 0, 0]];
  const local = localBounds(e);
  const corners = boundsCorners(local);
  return e.kind === 'cone' || e.kind === 'pyramid' ? [...corners.slice(0, 4), [0, 0, local.max[2]]] : corners;
}

/**
 * World AABB of one entity with `rotation` applied about `position` (three.js Rx·Ry·Rz). Zero rotation equals `entityBounds`; otherwise the
 * result wraps the rotated local geometry and carries `oriented:true`.
 */
export function orientedEntityBounds(e: Entity): Bounds {
  if (isZeroRotation(e.rotation)) return entityBounds(e);
  const rotated = localEntityCorners(e).map((local) =>
    applyEulerXYZ([e.position[0] + local[0], e.position[1] + local[1], e.position[2] + local[2]], e.position, e.rotation),
  );
  return { ...boundsOfPoints(rotated), oriented: true };
}

/** The 8 corners of an AABB. */
export function boundsCorners({ min, max }: Bounds): Vec3[] {
  return [min[2], max[2]].flatMap((z) => [
    [min[0], min[1], z] as Vec3,
    [max[0], min[1], z] as Vec3,
    [max[0], max[1], z] as Vec3,
    [min[0], max[1], z] as Vec3,
  ]);
}

/** Tight AABB of a non-empty point set. */
export function boundsOfPoints(points: readonly Vec3[]): Bounds {
  const { min, max } = positionsExtent(points.flat());
  return { min, max };
}

/** Deepest component-in-component nesting followed when computing instance bounds. */
const MAX_NESTING = 8;

/**
 * Compute the world AABB of an InstanceEntity by expanding it against its component's child entities. Callers that have access to the
 * document should prefer this over `entityBounds` for `instance` kind entities.
 *
 * Falls back to a point at the instance position when the component is empty or missing.
 */
export function instanceBoundsFromDoc(instance: InstanceEntity, doc: CadDocument, depth = 0): Bounds {
  const component = doc.components[instance.componentId];
  // Past MAX_NESTING a reference cycle is assumed: the instance counts as a point at its position.
  if (!component || component.order.length === 0 || depth >= MAX_NESTING) return { min: instance.position, max: instance.position };
  const { scale = [1, 1, 1], rotation, position } = instance;
  const toWorld = instanceToWorld(scale, rotation, position);
  const worldPoints: Vec3[] = [];
  for (const cid of component.order) {
    const child = component.entities[cid];
    if (!child) continue;
    for (const c of boundsCorners(entityBoundsInDoc(doc, child, depth + 1))) worldPoints.push(toWorld(c));
  }
  return worldPoints.length > 0 ? boundsOfPoints(worldPoints) : bounds(position, position);
}

/**
 * World AABB of `e`. Unlike `entityBounds` it resolves instances through their component in `doc` (a bare `entityBounds` call on an
 * instance yields a zero-size box at the origin).
 */
export function entityBoundsInDoc(doc: CadDocument, e: Entity, depth = 0): Bounds {
  if (e.kind === 'instance') return instanceBoundsFromDoc(e, doc, depth);
  if (e.kind === 'dimension') return dimensionBoundsFromDoc(e, doc);
  return orientedEntityBounds(e);
}

/**
 * A dimension has no geometry of its own: its extent is the referenced geometry grown by the witness-line `offset` (default 5) in X and Y.
 * With no resolvable reference it falls back to `entityBounds` (a small box around its own position).
 */
function dimensionBoundsFromDoc(dimension: DimensionEntity, doc: CadDocument): Bounds {
  const referenced = dimension.entityIds.flatMap((id): Bounds[] => {
    const target = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    return target && target.kind !== 'dimension' ? [entityBoundsInDoc(doc, target)] : [];
  });
  const [first, ...rest] = referenced;
  if (!first) return entityBounds(dimension);
  const { min, max } = rest.reduce(mergeBounds, first);
  const offset = Math.abs(dimension.offset ?? 5);
  return bounds([min[0] - offset, min[1] - offset, min[2]], [max[0] + offset, max[1] + offset, max[2]]);
}

/** True when two AABBs overlap (touching counts) on every axis. */
export function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

/** Centre of an AABB. */
export function boundsCenter({ min, max }: Bounds): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** Radius of the sphere around the centre of an AABB that passes through its corners. */
export function boundsDiagonalRadius({ min, max }: Bounds): number {
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
}

/** Largest side of an AABB. */
export function boundsExtent({ min, max }: Bounds): number {
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/** Radius of the sphere framing `bounds`: half the largest extent, 1 for a (near-)point scene. */
export function boundsRadius(bounds: Bounds): number {
  const radius = boundsExtent(bounds) / 2 + 1e-3;
  return radius < 0.1 ? 1 : radius;
}

export function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}
