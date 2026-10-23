/**
 * Resolved vessel geometry and its datum (plant 03 EQP §5.4): head shapes in document units, the bottom tangent line (vertical) or the
 * axis (horizontal) in the equipment frame (origin = plan location at the level elevation, +Z up), and the height of a head's inside surface
 * above its tangent line. One unit throughout: the document unit.
 */

import type { HeadSpec } from '../model';
import type { VesselTemplate } from '../plantData';
import { resolveHead, type HeadRefusal, type HeadShape } from './heads';

export interface VesselGeometry {
  readonly orientation: 'vertical' | 'horizontal';
  readonly radius: number;
  readonly length: number;
  readonly shellThickness: number;
  readonly headThickness: number;
  readonly first: HeadShape;
  readonly second: HeadShape;
  /** Vertical: z of the bottom tangent line. Horizontal: z of the vessel axis. */
  readonly datum: number;
  readonly unverified: boolean;
}

const isRefusal = (value: object): value is HeadRefusal => 'error' in value;

/** Elevation of the bottom tangent line (vertical) or of the axis (horizontal) in the equipment frame. */
export function vesselDatum(template: VesselTemplate): number {
  const { support } = template;
  const outerRadius = template.insideDiameter / 2 + template.shellThickness;
  switch (support.type) {
    case 'skirt':
    case 'legs':
      return support.height;
    case 'saddles':
      return support.axisElevation;
    case 'none':
      return template.orientation === 'vertical' ? support.baseElevation : support.baseElevation + outerRadius;
  }
}

function resolveSpec(spec: HeadSpec, radius: number, path: string): { shape: HeadShape; unverified: boolean } | HeadRefusal {
  const head = resolveHead(spec, radius, path);
  return isRefusal(head) ? head : { shape: head.shape, unverified: head.unverified };
}

/** The vessel's heads and datum, or the first invalid head (`EQP_HEAD_INVALID`, path under `heads`). */
export function resolveVessel(template: VesselTemplate): VesselGeometry | HeadRefusal {
  const radius = template.insideDiameter / 2;
  const first = resolveSpec(template.heads.first, radius, 'heads.first');
  if (isRefusal(first)) return first;
  const second = resolveSpec(template.heads.second, radius, 'heads.second');
  if (isRefusal(second)) return second;
  return {
    orientation: template.orientation,
    radius,
    length: template.tangentLength,
    shellThickness: template.shellThickness,
    headThickness: template.headThickness,
    first: first.shape,
    second: second.shape,
    datum: vesselDatum(template),
    unverified: first.unverified || second.unverified,
  };
}

/** Height of the inside surface of a head above its tangent line at radial distance `r` from the axis (0 at the rim, depth at the apex). */
export function headSurfaceHeight(shape: HeadShape, radius: number, r: number): number {
  const x = Math.min(Math.max(r, 0), radius);
  switch (shape.kind) {
    case 'flat':
      return 0;
    case 'ellipsoidal':
      return shape.depth * Math.sqrt(Math.max(0, 1 - (x / radius) ** 2));
    case 'spherical': {
      const sphere = (radius * radius + shape.depth * shape.depth) / (2 * shape.depth);
      return shape.depth - sphere + Math.sqrt(Math.max(0, sphere * sphere - x * x));
    }
    case 'conical':
      return shape.depth * (1 - x / radius);
    case 'torispherical': {
      const crownLimit = shape.crownRadius * Math.sin(shape.alpha);
      if (x <= crownLimit) return shape.depth - shape.crownRadius + Math.sqrt(Math.max(0, shape.crownRadius ** 2 - x * x));
      const offset = x - (radius - shape.knuckleRadius);
      return Math.sqrt(Math.max(0, shape.knuckleRadius ** 2 - offset * offset));
    }
  }
}

/** True when radial distance `r` lies in the knuckle zone (torispherical) or beyond 0.8 R (ellipsoidal): a nozzle there is a code concern. */
export function inKnuckleZone(shape: HeadShape, radius: number, r: number): boolean {
  if (shape.kind === 'torispherical') return r > shape.crownRadius * Math.sin(shape.alpha);
  return shape.kind === 'ellipsoidal' && r > 0.8 * radius;
}

/** Skirt radii: its inside radius is the shell outside radius (validation pack convention, VC-EQP-09), the wall grows outward by its thickness. */
export function skirtRadii(geometry: VesselGeometry, thickness: number): { inner: number; outer: number } {
  const inner = geometry.radius + geometry.shellThickness;
  return { inner, outer: inner + thickness };
}
