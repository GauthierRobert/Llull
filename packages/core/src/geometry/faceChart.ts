/**
 * The chart of a face for a method (03 WRP, TECHNICAL_SPEC §5.1 / §5.2): `develop` on plane, cylinder and cone; `geodesic` on every face a chart is built for
 * (the geodesic polar map of a developable face is its development); `parametric` on plane, cylinder, cone, sphere and torus.
 * @failure develop on a sphere or torus -> `not_developable`; a freeform (B-spline) face or a surface of revolution of another kind -> `unsupported_surface`
 */

import type { ChartMethod, ChartPlacement, ChartResult } from './chartFrame';
import { buildCurvedChart, parametricChartOf } from './curvedChart';
import type { SurfaceParams } from './kernelPorts';
import { buildFaceChart } from './wrapChart';

export function buildChart(surface: SurfaceParams, placement: ChartPlacement, method: ChartMethod): ChartResult {
  if (surface.type === 'sphere' || surface.type === 'torus')
    return method === 'develop' ? { error: 'not_developable' } : buildCurvedChart(surface, placement, method);
  if (surface.type === 'other') return { error: 'unsupported_surface' };
  const base = buildFaceChart(surface, placement);
  return 'error' in base || method !== 'parametric' ? base : parametricChartOf(base, placement);
}
