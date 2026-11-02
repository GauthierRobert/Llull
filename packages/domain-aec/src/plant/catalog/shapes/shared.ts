/**
 * Shared types and helpers of the component shape builders (plant 01 PSC M4): the flattened source of a shape, its outcome, refusals and the
 * finish step that rejects degenerate geometry.
 * @invariant pure; a shape is returned only when its bounds are a finite solid
 */

import type { ShapeRecipe } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { BendRadius, ComponentType, EndType } from '../types';
import { boundsOfDiscs, recipeStats, type Bounds, type Disc } from './geometry';

/** Everything a shape needs, flattened from a catalogue row or a resolved spec component. All lengths in mm. */
export interface ShapeSource {
  readonly type: ComponentType;
  readonly standard: string;
  readonly npsValue: number | null;
  readonly dims: Readonly<Record<string, number>>;
  /** Outside diameter of the pipe at the main size, and at the branch / small end. */
  readonly pipeOdMm?: number | undefined;
  readonly smallPipeOdMm?: number | undefined;
  readonly wallMm?: number | undefined;
  readonly radius?: BendRadius | undefined;
  readonly ratingClass?: number | undefined;
  readonly facing?: string | undefined;
  readonly lengthMm?: number | undefined;
  /** Outside diameter of the flange at a valve's size (valves are drawn as an envelope of face-to-face by flange diameter). */
  readonly flangeOdMm?: number | undefined;
}

export interface ShapePort {
  readonly id: string;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly outsideDiameterMm: number;
  readonly endType: EndType | null;
}

export interface ComponentShape {
  readonly recipe: ShapeRecipe;
  readonly bounds: Bounds;
  readonly ports: readonly ShapePort[];
  readonly hollow: boolean;
  readonly notes: readonly string[];
  readonly stats: { readonly leaves: number; readonly booleans: number };
  readonly frame: string;
}

export type ShapeOutcome =
  | { readonly ok: true; readonly shape: ComponentShape }
  | {
      readonly ok: false;
      readonly code: 'PSC_SHAPE_UNSUPPORTED' | 'PSC_CATALOG_ROW_MISSING' | 'PSC_CATALOG_DIM_MISMATCH';
      readonly message: string;
    };

export type Built = Omit<ComponentShape, 'bounds' | 'stats'> & { readonly discs: readonly Disc[] };

export const refusal = (code: Exclude<ShapeOutcome, { ok: true }>['code'], message: string): ShapeOutcome => ({ ok: false, code, message });
export const missing = (source: ShapeSource, ...names: string[]): ShapeOutcome =>
  refusal('PSC_CATALOG_ROW_MISSING', `the ${source.type} row (${source.standard}) lacks ${names.join(', ')}, which its shape needs`);
export const need = (source: ShapeSource, ...names: string[]): ShapeOutcome | null =>
  names.every((name) => source.dims[name] !== undefined)
    ? null
    : missing(source, ...names.filter((name) => source.dims[name] === undefined));
export const dim = (source: ShapeSource, name: string): number => source.dims[name] as number;
/** The shape of `built`, or a refusal when its bounds are not a finite solid (a zero or non-finite dimension in the row). */
export const finish = (built: Built): ShapeOutcome => {
  const bounds = boundsOfDiscs(built.discs);
  const solid = bounds.min.every(
    (low, axis) => Number.isFinite(low) && Number.isFinite(bounds.max[axis]) && (bounds.max[axis] as number) > low,
  );
  if (!solid) return refusal('PSC_CATALOG_DIM_MISMATCH', 'the row gives a degenerate shape (a dimension is zero or not finite)');
  return finishShape(built, bounds);
};

const finishShape = (built: Built, bounds: Bounds): ShapeOutcome => ({
  ok: true,
  shape: {
    recipe: built.recipe,
    bounds,
    ports: built.ports,
    hollow: built.hollow,
    notes: built.notes,
    frame: built.frame,
    stats: recipeStats(built.recipe),
  },
});
export const ENDS: Readonly<Partial<Record<ComponentType, EndType>>> = {
  weldolet: 'BW',
  sockolet: 'SW',
  threadolet: 'THD',
  flangeWeldNeck: 'BW',
  flangeSocketWeld: 'SW',
  flangeThreaded: 'THD',
  flangeSlipOn: 'PE',
  flangeLapJoint: 'PE',
};
