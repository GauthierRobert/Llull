/**
 * Closed-form bounds of the deformation laws over a body extent in the local frame (01 DEF §5.2, §5.7): second-derivative bound and mesh
 * refinement edge length, Jacobian range, fold limits, region-end creases, fibre lengths.
 */

import type { DeformRegion } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode } from './laws';
import { determinantBounds } from './lattice';
import { localDeterminant } from './laws';
import { determinantRange as pointRange } from './pointPush';
import { type LocalFrame, toLocal } from './frame';
import { rampAt } from './region';

/** Axis-aligned extent of a body in local frame coordinates. */
export interface LocalExtent {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** det J at or below this counts as a fold (01 DEF §5.9, Jacobian floor). */
export const JACOBIAN_FLOOR = 1e-6;

/** Local-frame extent of flat xyz `positions`. */
export function localExtentOf(frame: LocalFrame, positions: ReadonlyArray<number>): LocalExtent {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const q = toLocal(frame, [positions[i] as number, positions[i + 1] as number, positions[i + 2] as number]);
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a] as number, q[a] as number);
      max[a] = Math.max(max[a] as number, q[a] as number);
    }
  }
  return { min, max };
}

const lateral = (extent: LocalExtent): number =>
  Math.max(
    Math.hypot(Math.max(Math.abs(extent.min[0]), Math.abs(extent.max[0])), Math.max(Math.abs(extent.min[1]), Math.abs(extent.max[1]))),
    0,
  );

/** Largest |dw/dz| and |d²w/dz²| of the ramp (closed form per falloff). */
function rampRates(region: DeformRegion): { d1: number; d2: number } {
  const length = region.end - region.start;
  if (region.falloff === 'smooth') return { d1: 1.5 / length, d2: 6 / (length * length) };
  return { d1: region.falloff === 'linear' ? 1 / length : 0, d2: 0 };
}

/**
 * Bound M2 of the second derivative of the map along any straight line over `extent` (the radial part, 01 DEF §5.7 table):
 * twist θ'²ρ + |θ''|ρ, taper |s''|ρ, bend (R + |y|max)/R², others 0.
 */
export function curvatureBound(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent): number {
  const { law, region } = node;
  if (region === undefined) return 0;
  const rates = rampRates(region);
  switch (law.kind) {
    case 'twist': {
      const rate = Math.abs(law.angleRad) * rates.d1;
      return (rate * rate + Math.abs(law.angleRad) * rates.d2) * lateral(extent);
    }
    case 'taper':
      return Math.abs(law.scaleEnd - 1) * rates.d2 * lateral(extent);
    case 'bend':
      return (law.radius + Math.max(Math.abs(extent.min[1]), Math.abs(extent.max[1]))) / (law.radius * law.radius);
    default:
      return 0;
  }
}

/** Cross term of the second derivative along an oblique line (the radial part ignores it): twist |θ'|, taper |s'|, bend 1/R. */
function obliqueBound(node: Pick<DeformNode, 'law' | 'region'>): number {
  const { law, region } = node;
  if (region === undefined) return 0;
  const rate = rampRates(region).d1;
  if (law.kind === 'twist') return Math.abs(law.angleRad) * rate;
  if (law.kind === 'taper') return Math.abs(law.scaleEnd - 1) * rate;
  return law.kind === 'bend' ? 1 / law.radius : 0;
}

/** Edge length h = √(8 tol / M2) keeping the chordal deviation of a straight edge within `tolerance`; the `radial` form is the spec table. */
export function edgeLengthFor(curvature: number, tolerance: number): number {
  return curvature > 0 ? Math.sqrt((8 * tolerance) / curvature) : Infinity;
}

/** Longest edge the mesh path may keep over `extent` (radial and oblique terms together); Infinity when the map is straight-preserving. */
export function maxEdgeLength(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent, tolerance: number): number {
  return edgeLengthFor(curvatureBound(node, extent) + obliqueBound(node), tolerance);
}

/** Local heights where the map has a kink (region ends), for laws that are not smooth there. */
export function splitHeights(node: Pick<DeformNode, 'law' | 'region'>): number[] {
  const { law, region } = node;
  if (region === undefined || law.kind === 'affine') return [];
  if (law.kind === 'stretch' || law.kind === 'bend' || region.falloff === 'linear') return [region.start, region.end];
  return [];
}

export interface JacobianRange {
  readonly min: number;
  readonly max: number;
  /** A guaranteed enclosure of det J over the body (lattice: Bernstein coefficients of det J), when the law has one. */
  readonly bound?: { readonly min: number; readonly max: number; readonly method: string };
  /** Local point where the minimum is reached. */
  readonly minAt: Vec3;
}

const overlaps = (region: DeformRegion, extent: LocalExtent): boolean => extent.max[2] > region.start && extent.min[2] <= region.end;
const extendsOutside = (region: DeformRegion, extent: LocalExtent): boolean => extent.min[2] < region.start || extent.max[2] > region.end;

/** Range of det J over `extent`, closed form per law (monotone ramps, linear (R − y)/R). */
export function jacobianRange(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent): JacobianRange {
  const { law, region } = node;
  const corner = (z: number, y = extent.min[1]): Vec3 => [extent.min[0], y, z];
  if (law.kind === 'affine') {
    const [a, b, c] = law.matrix;
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    return { min: det, max: det, minAt: corner(extent.min[2]) };
  }
  if (law.kind === 'lattice') {
    const bounds = determinantBounds(law);
    return {
      min: bounds.sampledMin,
      max: bounds.sampledMax,
      minAt: bounds.sampledMinAt,
      bound: { min: bounds.boundMin, max: bounds.boundMax, method: 'Bernstein coefficients of det J over the lattice box' },
    };
  }
  if (law.kind === 'point') {
    const reaches = [0, 1, 2].every(
      (a) =>
        (law.center[a] as number) + law.radius > (extent.min[a] as number) &&
        (law.center[a] as number) - law.radius < (extent.max[a] as number),
    );
    if (!reaches) return { min: 1, max: 1, minAt: corner(extent.min[2]) };
    const range = pointRange(law);
    return { ...range, minAt: law.center, bound: { ...range, method: 'closed form: 1 -/+ |distance| max|phi prime| / radius' } };
  }
  if (law.kind === 'flowCurve' || law.kind === 'flowSurface') return sampledFlowRange(node, extent);
  if (law.kind === 'rbf') return sampledFlowRange(node, extent, 13, 13);
  if (region === undefined || law.kind === 'twist') return { min: 1, max: 1, minAt: corner(extent.min[2]) };
  if (law.kind === 'taper') {
    const det = (z: number): number => {
      const s = 1 + (law.scaleEnd - 1) * rampAt(region, z).w;
      return law.flat ? s : s * s;
    };
    const [low, high] = [det(extent.min[2]), det(extent.max[2])];
    return low <= high ? { min: low, max: high, minAt: corner(extent.min[2]) } : { min: high, max: low, minAt: corner(extent.max[2]) };
  }
  const inside = overlaps(region, extent);
  if (law.kind === 'stretch') {
    const values = [...(inside ? [law.factor] : []), ...(!inside || extendsOutside(region, extent) ? [1] : [])];
    const min = Math.min(...values);
    return { min, max: Math.max(...values), minAt: corner(Math.max(extent.min[2], region.start)) };
  }
  const [low, high] = [(law.radius - extent.max[1]) / law.radius, (law.radius - extent.min[1]) / law.radius];
  const values = [...(inside ? [low, high] : []), ...(!inside || extendsOutside(region, extent) ? [1] : [])];
  return { min: Math.min(...values), max: Math.max(...values), minAt: corner(Math.max(extent.min[2], region.start), extent.max[1]) };
}

/** Placeholder region of a flow (its law ignores it). */
const FLOW_REGION: DeformRegion = { start: -Infinity, end: Infinity, falloff: 'none', beyond: 'rigid' };

/**
 * det J of a map without a closed form (a flow, a fitted field) over a grid of the body extent: `along` steps in z, `across` samples in x and y (corners, edges,
 * middles when 3).
 */
function sampledFlowRange(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent, across = 3, along = 48): JacobianRange {
  let min = Infinity;
  let max = -Infinity;
  let minAt: Vec3 = extent.min;
  const level = (axis: 0 | 1, k: number): number => extent.min[axis] + ((extent.max[axis] - extent.min[axis]) * k) / (across - 1);
  for (let i = 0; i <= along; i++) {
    const z = extent.min[2] + ((extent.max[2] - extent.min[2]) * i) / along;
    for (let j = 0; j < across; j++)
      for (let k = 0; k < across; k++) {
        const point: Vec3 = [level(0, j), level(1, k), z];
        const value = localDeterminant(node.law, node.region ?? FLOW_REGION, point);
        if (value < min) {
          min = value;
          minAt = point;
        }
        max = Math.max(max, value);
      }
  }
  return { min, max, minAt };
}

export interface RegionCrease {
  readonly at: 'start' | 'end';
  readonly angleRad: number;
  /** The body extends past this end of the region, so the crease exists on the part. */
  readonly present: boolean;
}

/**
 * Angle between the face normals just inside and outside each region end for twist and taper (box-face form: atan(rate × lateral half
 * extent), rate = the law's lateral slope at the end; 0 for a smooth ramp). Empty for other laws.
 */
export function regionCreases(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent): RegionCrease[] {
  const { law, region } = node;
  if (region === undefined || (law.kind !== 'twist' && law.kind !== 'taper')) return [];
  const half = Math.max(extent.max[0], -extent.min[0], extent.max[1], -extent.min[1]);
  const total = law.kind === 'twist' ? Math.abs(law.angleRad) : Math.abs(law.scaleEnd - 1);
  const angleRad = Math.atan(total * rampRatesAtEnds(region) * half);
  return [
    { at: 'start', angleRad, present: extent.min[2] < region.start },
    { at: 'end', angleRad, present: extent.max[2] > region.end },
  ];
}

/** Slope of the ramp at its ends (per document unit): 1/length for linear, 0 for smooth, 0 for a step. */
function rampRatesAtEnds(region: DeformRegion): number {
  return region.falloff === 'linear' ? 1 / (region.end - region.start) : 0;
}

export interface BendFibres {
  readonly neutral: number;
  readonly inner: number;
  readonly outer: number;
}

/** Lengths of the neutral, innermost and outermost fibres of a bend of angle (end − start)/R over `extent`. */
export function bendFibres(node: Pick<DeformNode, 'law' | 'region'>, extent: LocalExtent): BendFibres | null {
  const { law, region } = node;
  if (law.kind !== 'bend' || region === undefined) return null;
  const angle = (region.end - region.start) / law.radius;
  return {
    neutral: law.radius * angle,
    inner: (law.radius - Math.max(extent.max[1], 0)) * angle,
    outer: (law.radius - Math.min(extent.min[1], 0)) * angle,
  };
}
