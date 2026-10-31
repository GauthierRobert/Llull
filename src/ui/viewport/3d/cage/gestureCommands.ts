// A cage gesture -> the ONE registered command it commits (PRIME DIRECTIVE), and the `llull` line that repeats it. Pure.
// Params follow the zod schemas in packages/core/src/commands/subdivision/*.ts.

import type { Vec3 } from '@core/model/types';
import type { FalloffShape } from '@lib/falloff';
import { type CageSelection, isSelectionEmpty, selectionParams } from './cageSelection';

export type FalloffMetric = 'euclidean' | 'topological';

export interface FalloffSettings {
  /** Soft-selection radius in document units; 0 = no falloff. */
  readonly radius: number;
  readonly shape: FalloffShape;
  readonly metric: FalloffMetric;
}

export const DEFAULT_FALLOFF: FalloffSettings = { radius: 0, shape: 'smooth', metric: 'euclidean' };

export type CageGesture =
  | { readonly kind: 'translate'; readonly delta: Vec3 }
  | { readonly kind: 'rotate'; readonly axis: Vec3; readonly angleDeg: number; readonly pivot: Vec3 }
  | { readonly kind: 'scale'; readonly factors: Vec3; readonly pivot: Vec3 }
  | { readonly kind: 'extrude'; readonly distance: number }
  | { readonly kind: 'inset'; readonly thickness: number }
  | {
      readonly kind: 'loop_cut';
      readonly edge: string;
      readonly cuts: number;
      /** Dragged position along the crossed edges (cuts 1 only). */ readonly factor?: number;
    };

export interface CageCommand {
  readonly name: 'edit_subdivision_cage' | 'extrude_cage_faces' | 'inset_cage_faces' | 'loop_cut_cage';
  readonly params: Readonly<Record<string, unknown>>;
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6 + 0;
const roundVec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/** The `falloff` param: a bare radius for the defaults, `{ radius, shape, metric }` otherwise, absent for radius 0. */
export function falloffParam(
  falloff: FalloffSettings,
): number | { radius: number; shape: FalloffShape; metric: FalloffMetric } | undefined {
  if (!(falloff.radius > 0)) return undefined;
  const radius = round(falloff.radius);
  return falloff.shape === 'smooth' && falloff.metric === 'euclidean' ? radius : { radius, shape: falloff.shape, metric: falloff.metric };
}

/** Is the gesture a no-op (a click that moved nothing)? */
export function isIdleGesture(gesture: CageGesture): boolean {
  switch (gesture.kind) {
    case 'translate':
      return Math.hypot(...gesture.delta) < 1e-6;
    case 'rotate':
      return Math.abs(gesture.angleDeg) < 1e-4;
    case 'scale':
      return gesture.factors.every((factor) => Math.abs(factor - 1) < 1e-6);
    case 'extrude':
      return Math.abs(gesture.distance) < 1e-6;
    case 'inset':
      return !(gesture.thickness > 0);
    case 'loop_cut':
      return false;
  }
}

/** The command a gesture commits, or null when the selection does not suit it (extrude / inset need faces) or the gesture is idle. */
export function gestureCommand(
  entityId: string,
  gesture: CageGesture,
  selection: CageSelection,
  falloff: FalloffSettings,
): CageCommand | null {
  if (gesture.kind === 'loop_cut') {
    const { factor } = gesture;
    return {
      name: 'loop_cut_cage',
      params: { id: entityId, edge: gesture.edge, cuts: gesture.cuts, ...(factor !== undefined && gesture.cuts === 1 ? { factor } : {}) },
    };
  }
  if (isIdleGesture(gesture) || isSelectionEmpty(selection)) return null;
  if (gesture.kind === 'extrude' || gesture.kind === 'inset') {
    if (selection.faces.length === 0) return null;
    const faces = [...selection.faces];
    return gesture.kind === 'extrude'
      ? { name: 'extrude_cage_faces', params: { id: entityId, faces, distance: round(gesture.distance) } }
      : { name: 'inset_cage_faces', params: { id: entityId, faces, thickness: round(gesture.thickness) } };
  }
  const soft = falloffParam(falloff);
  const base = { id: entityId, ...selectionParams(selection), ...(soft === undefined ? {} : { falloff: soft }) };
  switch (gesture.kind) {
    case 'translate':
      return { name: 'edit_subdivision_cage', params: { ...base, translate: roundVec(gesture.delta) } };
    case 'rotate':
      return {
        name: 'edit_subdivision_cage',
        params: { ...base, rotate: { axis: roundVec(gesture.axis), angleDeg: round(gesture.angleDeg), pivot: roundVec(gesture.pivot) } },
      };
    case 'scale': {
      return { name: 'edit_subdivision_cage', params: { ...base, scale: roundVec(gesture.factors), pivot: roundVec(gesture.pivot) } };
    }
  }
}

/** Shell line that repeats `command` on the open desktop app (single quotes escaped for POSIX shells). */
export function cliLine(command: CageCommand): string {
  const json = JSON.stringify(command.params).replace(/'/g, `'\\''`);
  return `llull exec ${command.name} '${json}' --app`;
}
