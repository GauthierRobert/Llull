/**
 * Viewport overlays of the surface analysis (02 SRF FR-SRF-23): the curvature comb of a curve and colour maps of a sheet (Gaussian / mean
 * curvature, zebra isophote stripes, draft). Pure geometry + colour: the UI draws what these return, the numbers are the ones the
 * analysis commands report.
 */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3, scale3, sub3 } from '../../lib/vec3';
import { curvatureAt, planeNormalOf } from '../../lib/nurbs/curvature';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';

export type SurfaceMapMode = 'gaussian' | 'mean' | 'zebra' | 'draft';

export const SURFACE_MAP_MODES: ReadonlyArray<SurfaceMapMode> = ['gaussian', 'mean', 'zebra', 'draft'];

export interface CombGeometry {
  /** Curve points followed by their tooth tips, flattened [x, y, z, ...] as pairs: tooth k runs from (6k, 6k + 1, 6k + 2) to (6k + 3, ...). */
  readonly teeth: number[];
  /** The envelope through the tooth tips, flattened [x, y, z, ...]. */
  readonly envelope: number[];
  /** Largest curvature among the samples (1/length). */
  readonly maxCurvature: number;
}

/**
 * Curvature comb of `curve`: `count` teeth of length curvature x scale pointing away from the centre of curvature (the convention of
 * analyze_curve_curvature). `scale` null picks one that makes the longest tooth `fraction` of the curve's pole extent.
 */
export function curveComb(curve: NurbsCurveData, count: number, scale: number | null, fraction = 0.15): CombGeometry {
  const [first, last] = curveDomain(curve);
  const planeNormal = planeNormalOf(curve);
  const samples = Array.from({ length: count }, (_, k) => curvatureAt(curve, first + ((last - first) * k) / (count - 1), planeNormal));
  const live = samples.filter((sample) => !sample.degenerate);
  const maxCurvature = Math.max(0, ...live.map((sample) => sample.curvature));
  const extent = Math.max(
    ...[0, 1, 2].map(
      (axis) => Math.max(...curve.poles.map((p) => p[axis] as number)) - Math.min(...curve.poles.map((p) => p[axis] as number)),
    ),
    1e-12,
  );
  const length = scale ?? (maxCurvature > 0 ? (fraction * extent) / maxCurvature : 0);
  const teeth: number[] = [];
  const envelope: number[] = [];
  for (const sample of live) {
    const tip = sub3(sample.point, scale3(sample.normal, sample.curvature * length));
    teeth.push(...sample.point, ...tip);
    envelope.push(...tip);
  }
  return { teeth, envelope, maxCurvature };
}

export interface SurfaceMapOptions {
  /** Zebra: direction of the light the stripes are the isophotes of; draft: the pull direction. Default [0, 0, 1]. */
  readonly direction?: Vec3;
  /** Zebra: stripe pairs from facing to grazing (default 12). */
  readonly stripes?: number;
  /** Draft: reverse the sheet normal (S_u x S_v). */
  readonly flip?: boolean;
}

/** Diverging ramp: blue (negative) - white (0) - red (positive), by value / extent in [-1, 1]. */
function diverging(t: number): [number, number, number] {
  const u = Math.max(-1, Math.min(1, t));
  return u < 0 ? [1 + u, 1 + u, 1] : [1, 1 - u, 1 - u];
}

/** Scalar of `mode` at one surface sample, or null at a singular point. */
function scalarAt(surface: NurbsSurfaceData, u: number, v: number, mode: SurfaceMapMode, options: SurfaceMapOptions): number | null {
  const sample = surfaceSample(surface, u, v);
  if (sample.degenerate) return null;
  const direction = options.direction ?? [0, 0, 1];
  const unit = scale3(direction, 1 / (len3(direction) || 1));
  const normal = options.flip === true ? scale3(sample.normal, -1) : sample.normal;
  switch (mode) {
    case 'gaussian':
      return sample.gaussian;
    case 'mean':
      return sample.mean;
    case 'zebra':
      return Math.acos(Math.max(-1, Math.min(1, dot3(sample.normal, unit))));
    case 'draft':
      return (Math.asin(Math.max(-1, Math.min(1, dot3(normal, unit)))) * 180) / Math.PI;
  }
}

/**
 * Vertex colours (r, g, b in 0..1, three numbers per entry of `uv`) of the map `mode` on `surface`: curvature maps are diverging about zero
 * and scaled by the largest magnitude present, zebra is black / white isophote stripes of the angle between the normal and the light, draft
 * is red below 0 degrees (undercut), amber up to 3 degrees, green above. Singular points get neutral grey.
 */
export function surfaceMapColors(
  surface: NurbsSurfaceData,
  uv: ReadonlyArray<readonly [number, number]>,
  mode: SurfaceMapMode,
  options: SurfaceMapOptions = {},
): number[] {
  const values = uv.map(([u, v]) => scalarAt(surface, u, v, mode, options));
  const largest = Math.max(1e-300, ...values.map((value) => Math.abs(value ?? 0)));
  const stripes = Math.max(1, options.stripes ?? 12);
  return values.flatMap((value): number[] => {
    if (value === null) return [0.6, 0.6, 0.6];
    if (mode === 'zebra') {
      const band = Math.floor((value / Math.PI) * stripes * 2) % 2 === 0 ? 0.08 : 0.97;
      return [band, band, band];
    }
    if (mode === 'draft') return value < 0 ? [0.85, 0.1, 0.1] : value < 3 ? [0.95, 0.65, 0.1] : [0.2, 0.7, 0.3];
    return diverging(value / largest);
  });
}
