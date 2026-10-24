// Control polygons and nets of NURBS entities (VC-37), as pure data: line segments of the net, the poles with their world positions, the pole
// under a ray, and the ONE command that moves a pole (`edit_nurbs` / `edit_nurbs_surface` move_poles). Poles are entity-local; no React, no stores.

import type { NurbsCurveEntity, NurbsSurfaceEntity, Vec3 } from '@core/model/types';
import { applyEulerXYZ, inverseEulerXYZ } from '@lib/eulerRotation';
import { add3, dot3, scale3, sub3 } from '@lib/vec3';

export type NurbsNetEntity = NurbsCurveEntity | NurbsSurfaceEntity;

/** A pole by its index in the entity: `index` on a curve, `[i, j]` (u row, v column) on a surface. */
export type PoleId = number | readonly [number, number];

export interface Pole {
  readonly id: PoleId;
  /** Entity-local position. */
  readonly local: Vec3;
}

export const isNurbsNetEntity = (entity: { kind: string } | undefined): entity is NurbsNetEntity =>
  entity?.kind === 'nurbs_curve' || entity?.kind === 'nurbs_surface';

export function polesOf(entity: NurbsNetEntity): Pole[] {
  if (entity.kind === 'nurbs_curve') return entity.curve.poles.map((local, index) => ({ id: index, local }));
  return entity.surface.poles.flatMap((row, i) => row.map((local, j): Pole => ({ id: [i, j], local })));
}

/** Net segments (pairs of points, flat xyz, entity-local minus `anchor`, the floating origin of the buffers): the control polygon of a curve, the rows and columns of a surface net. */
export function netSegments(entity: NurbsNetEntity, anchor: Vec3 = [0, 0, 0]): Float32Array {
  const out: number[] = [];
  const push = (a: Vec3, b: Vec3): void =>
    void out.push(a[0] - anchor[0], a[1] - anchor[1], a[2] - anchor[2], b[0] - anchor[0], b[1] - anchor[1], b[2] - anchor[2]);
  if (entity.kind === 'nurbs_curve') {
    const { poles } = entity.curve;
    for (let k = 0; k + 1 < poles.length; k++) push(poles[k] as Vec3, poles[k + 1] as Vec3);
  } else {
    const { poles } = entity.surface;
    poles.forEach((row, i) =>
      row.forEach((pole, j) => {
        const along = row[j + 1];
        const down = poles[i + 1]?.[j];
        if (along !== undefined) push(pole, along);
        if (down !== undefined) push(pole, down);
      }),
    );
  }
  return new Float32Array(out);
}

/** First pole: the anchor the overlay buffers are re-based on (float32 attributes stay small, the transform re-adds it in float64). */
export const netAnchor = (entity: NurbsNetEntity): Vec3 => polesOf(entity)[0]?.local ?? [0, 0, 0];

/** Flat xyz of the poles (entity-local minus the anchor); `only` limits it to one pole. */
export function poleBuffer(entity: NurbsNetEntity, anchor: Vec3, only?: PoleId): Float32Array {
  const same = (a: PoleId, b: PoleId): boolean =>
    typeof a === 'number' || typeof b === 'number' ? a === b : a[0] === b[0] && a[1] === b[1];
  const chosen = polesOf(entity).filter((pole) => only === undefined || same(pole.id, only));
  const out = new Float32Array(chosen.length * 3);
  chosen.forEach((pole, k) => out.set([pole.local[0] - anchor[0], pole.local[1] - anchor[1], pole.local[2] - anchor[2]], k * 3));
  return out;
}

/** Entity-local point to document space. */
export const toWorld = (entity: Pick<NurbsNetEntity, 'position' | 'rotation'>, local: Vec3): Vec3 =>
  add3(applyEulerXYZ(local, [0, 0, 0], entity.rotation), entity.position);

/** A world displacement as the entity-local delta of the command. */
const toLocalDelta = (entity: Pick<NurbsNetEntity, 'rotation'>, delta: Vec3): Vec3 => inverseEulerXYZ(delta, entity.rotation);

export interface PoleRay {
  readonly origin: Vec3;
  /** Unit length. */
  readonly direction: Vec3;
}

/** The pole nearest the ray within `pixels` of screen, or null. `unitsPerPixelAt(t)`: world size of a pixel at ray distance t. */
export function pickPole(
  entity: NurbsNetEntity,
  ray: PoleRay,
  pixels: number,
  unitsPerPixelAt: (distance: number) => number,
): { pole: Pole; world: Vec3 } | null {
  let best: { pole: Pole; world: Vec3; score: number } | null = null;
  for (const pole of polesOf(entity)) {
    const world = toWorld(entity, pole.local);
    const offset = sub3(world, ray.origin);
    const t = dot3(offset, ray.direction);
    if (t <= 0) continue;
    const miss = sub3(offset, scale3(ray.direction, t));
    const distance = Math.sqrt(dot3(miss, miss));
    const score = distance / Math.max(1e-12, unitsPerPixelAt(t));
    if (score <= pixels && (best === null || score < best.score)) best = { pole, world, score };
  }
  return best === null ? null : { pole: best.pole, world: best.world };
}

export interface PoleCommand {
  readonly name: 'edit_nurbs' | 'edit_nurbs_surface';
  readonly params: Readonly<Record<string, unknown>>;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;

/** The command that moves `pole` by the world displacement `delta`, or null for a zero move. */
export function poleMoveCommand(entity: NurbsNetEntity, pole: PoleId, delta: Vec3): PoleCommand | null {
  const local = toLocalDelta(entity, delta);
  if (Math.hypot(...local) < 1e-6) return null;
  const rounded: Vec3 = [round(local[0]), round(local[1]), round(local[2])];
  if (entity.kind === 'nurbs_curve')
    return typeof pole === 'number'
      ? { name: 'edit_nurbs', params: { id: entity.id, operation: 'move_poles', indices: [pole], delta: rounded } }
      : null;
  return typeof pole === 'number'
    ? null
    : { name: 'edit_nurbs_surface', params: { id: entity.id, operation: 'move_poles', poles: [[pole[0], pole[1]]], delta: rounded } };
}
