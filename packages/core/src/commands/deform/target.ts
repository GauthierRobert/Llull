/** What a deformation command needs from its target (01 DEF §2.2): the entity, its exact source recipe, world triangles and the body-derived defaults. */

import type { DeformFrame, DeformRegion } from '../../model/deform';
import { type CadDocument, type Entity, type MeshData, type ShapeRecipe, type Vec3, is3D } from '../../model/types';
import { type LocalExtent, localExtentOf } from '../../geometry/deform/bounds';
import { resolveFrame, toLocal } from '../../geometry/deform/frame';
import { entityToTriangles } from '../../geometry/entityTriangles';
import type { GeometryKernel } from '../../geometry/kernel';
import { operandRecipe } from '../../geometry/operandRecipe';
import { recipeOf } from '../../geometry/shapeRecipe';
import { clamp } from '../../lib/clamp';
import { cross3, dot3, normalize3 } from '../../lib/vec3';
import { currentContext } from '../context';
import type { CommandResult, ExecutionContext } from '../types';
import { defRejection } from './codes';

export interface DeformTarget {
  readonly entity: Entity;
  readonly kernel: GeometryKernel | null;
  /** Exact construction of the entity (its recipe tree, or the stored triangles when the kernel cannot rebuild it). */
  readonly source: ShapeRecipe;
  /** World-space triangles of the source (indexed; the kernel tessellation when a kernel builds it, else the entity's own triangles). */
  readonly mesh: MeshData;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Bounding-box diagonal, document units. */
  readonly diagonal: number;
}

/** A refusal found while planning: stable code, text, offending param paths. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly paths: readonly string[];
}

export const isRefusal = (value: object): value is Refusal => 'code' in value;

function trianglesOf(entity: Entity, doc: CadDocument): MeshData {
  const positions = entityToTriangles(entity, doc).flatMap((triangle) => triangle.flat());
  return { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}

function extentOfPositions(positions: ReadonlyArray<number>): { min: Vec3; max: Vec3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, positions[i + a] as number);
      max[a] = Math.max(max[a] as number, positions[i + a] as number);
    }
  }
  return { min, max };
}

/**
 * Resolve `id` to a deformable solid.
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; 2D shape, curve, sheet, instance, image or an entity without triangles -> DEF_TARGET_UNSUPPORTED
 */
export function loadTarget(doc: CadDocument, command: string, id: string, ctx: ExecutionContext | undefined): DeformTarget | CommandResult {
  const entity = doc.entities[id];
  if (entity === undefined) return defRejection(doc, command, 'DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`, [id], ['params.id']);
  const unsupported = (why: string): CommandResult => defRejection(doc, command, 'DEF_TARGET_UNSUPPORTED', why, [id], ['params.id']);
  if (!is3D(entity) || entity.kind === 'instance' || entity.kind === 'image')
    return unsupported(`entity '${id}' (kind '${entity.kind}') is not a 3D solid or mesh`);
  const kernel = (ctx ?? currentContext()).kernel;
  const source = kernel === null ? recipeOf(entity) : operandRecipe(kernel, entity);
  const shape = kernel === null ? null : kernel.evaluate(source);
  const built = shape === null || kernel === null ? null : kernel.tessellate(shape);
  const mesh = built !== null && built.indices.length > 0 ? built : trianglesOf(entity, doc);
  if (mesh.indices.length === 0) return unsupported(`entity '${id}' (kind '${entity.kind}') has no triangles`);
  const { min, max } = extentOfPositions(mesh.positions);
  return { entity, kernel, source, mesh, min, max, diagonal: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) };
}

export const isTarget = (value: DeformTarget | CommandResult): value is DeformTarget => 'mesh' in value;

/** Default `output.tolerance`: 1e-5 x diagonal clamped to [1e-6, 0.01] (01 DEF §5.9). */
export const defaultTolerance = (diagonal: number): number => clamp(1e-5 * diagonal, 1e-6, 0.01);

const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface FrameInput {
  readonly origin?: Vec3 | undefined;
  readonly axis?: Vec3 | undefined;
  readonly reference?: Vec3 | undefined;
}

export interface ResolvedFrame {
  readonly frame: DeformFrame;
  readonly extent: LocalExtent;
  /** Which of origin / axis / reference came from the body bounds. */
  readonly defaulted: string[];
}

/** World axes sorted by bounding-box extent, longest first (ties: lowest index first). */
function axesByExtent(target: DeformTarget): Vec3[] {
  const extentOf = (axis: number): number => (target.max[axis] as number) - (target.min[axis] as number);
  return [0, 1, 2].sort((a, b) => extentOf(b) - extentOf(a) || a - b).map((index) => AXES[index] as Vec3);
}

/**
 * The frame of a deformation: caller values, else defaults from the body (axis = longest box direction, reference = the next longest not
 * parallel to it, origin = box centre, or for `origin: 'start'` the centre of the face where the body starts along the axis).
 * `referenceAs: 'y'` reads the reference as the local y direction (the bend: toward the centre of curvature); the stored frame then carries the
 * matching x direction, so every recipe frame keeps the one convention x = reference.
 * @failure zero axis or reference parallel to the axis -> DEF_FRAME_DEGENERATE
 */
export function resolveTargetFrame(
  target: DeformTarget,
  input: FrameInput | undefined,
  origin: 'centre' | 'start',
  referenceAs: 'x' | 'y' = 'x',
): ResolvedFrame | Refusal {
  const defaulted: string[] = [];
  const order = axesByExtent(target);
  const axisInput = input?.axis;
  const axis = axisInput ?? (order[0] as Vec3);
  if (axisInput === undefined) defaulted.push('axis');
  const unit = normalize3(axis);
  let reference = input?.reference;
  if (reference === undefined) {
    defaulted.push('reference');
    reference = order.find((candidate) => Math.abs(dot3(candidate, unit)) < 0.99) ?? (order[1] as Vec3);
  }
  const centre: Vec3 = [(target.min[0] + target.max[0]) / 2, (target.min[1] + target.max[1]) / 2, (target.min[2] + target.max[2]) / 2];
  let frame: DeformFrame = { origin: input?.origin ?? centre, axis, reference };
  if (input?.origin === undefined) defaulted.push('origin');
  const local = resolveFrame(frame);
  if (local === null)
    return {
      code: 'DEF_FRAME_DEGENERATE',
      message: 'the frame axis is zero or the reference is parallel to it',
      paths: input?.reference === undefined ? ['params.frame.axis'] : ['params.frame.reference'],
    };
  let extent = localExtentOf(local, target.mesh.positions);
  if (referenceAs === 'y') {
    frame = { ...frame, reference: cross3(local.x, local.z) };
    extent = localExtentOf(resolveFrame(frame) ?? local, target.mesh.positions);
  }
  if (input?.origin === undefined && origin === 'start') {
    const shifted: Vec3 = [
      centre[0] + local.z[0] * extent.min[2],
      centre[1] + local.z[1] * extent.min[2],
      centre[2] + local.z[2] * extent.min[2],
    ];
    frame = { ...frame, origin: shifted };
    extent = localExtentOf(resolveFrame(frame) ?? local, target.mesh.positions);
  }
  return { frame, extent, defaulted };
}

export interface RegionInput {
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly falloff?: 'smooth' | 'linear' | undefined;
}

/**
 * The region of a deformation: caller values, else the body extent along the axis.
 * @failure end <= start or non-finite -> DEF_REGION_INVALID; the region does not overlap the body -> DEF_REGION_MISSES_BODY
 */
export function resolveRegion(
  extent: LocalExtent,
  input: RegionInput | undefined,
  falloff: DeformRegion['falloff'] = 'smooth',
): DeformRegion | Refusal {
  const start = input?.start ?? extent.min[2];
  const end = input?.end ?? extent.max[2];
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start))
    return {
      code: 'DEF_REGION_INVALID',
      message: `region start ${start} and end ${end} must be finite with end > start`,
      paths: ['params.region'],
    };
  if (end <= extent.min[2] || start >= extent.max[2])
    return {
      code: 'DEF_REGION_MISSES_BODY',
      message: `region ${start}..${end} does not meet the body, which spans ${extent.min[2]}..${extent.max[2]} along the axis`,
      paths: ['params.region'],
    };
  return { start, end, falloff: input?.falloff ?? falloff, beyond: 'rigid' };
}

/**
 * Local extent of the triangles that meet the open region (start, end): the part of the body a region law acts on. Falls back to the whole
 * body extent when no triangle meets it.
 */
export function extentWithin(target: DeformTarget, frame: DeformFrame, start: number, end: number, whole: LocalExtent): LocalExtent {
  const local = resolveFrame(frame);
  if (local === null) return whole;
  const { positions } = target.mesh;
  const points: number[] = [];
  const { indices } = target.mesh;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) =>
      toLocal(local, [
        positions[(indices[t + k] as number) * 3] as number,
        positions[(indices[t + k] as number) * 3 + 1] as number,
        positions[(indices[t + k] as number) * 3 + 2] as number,
      ]),
    );
    const zs = corners.map((q) => q[2]);
    if (Math.max(...zs) <= start || Math.min(...zs) >= end) continue;
    for (const q of corners) points.push(q[0], q[1], q[2]);
  }
  if (points.length === 0) return whole;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, points[i + a] as number);
      max[a] = Math.max(max[a] as number, points[i + a] as number);
    }
  return { min, max };
}
