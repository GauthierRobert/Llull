/** LIM-1: a variable-section sweep is fitted in runs cut at its interior stations, where the section blend is only C1 (smooth) or C0 (linear). */
import { describe, it, expect } from 'vitest';
import { type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fitSweepFaces, fitToleranceOf, type FittedSweep } from '@core/geometry/sweepEval/fitted';

const PATH = [
  [0, 0, 0],
  [0, 40, 120],
  [30, 90, 220],
  [80, 110, 300],
];

function fitted(stations: ReadonlyArray<Record<string, number>>, extra: Record<string, unknown> = {}): FittedSweep {
  const result = execute(createEmptyDocument(), 'sweep_profile', { path: PATH, smooth: true, stations, ...extra });
  expect(result.affected, result.summary).toHaveLength(1);
  const sweep = result.document.entities[result.affected[0] as string] as SweepEntity;
  const fit = fitSweepFaces(sweep, fitToleranceOf(sweep));
  if (!('faces' in fit)) throw new Error(fit.message);
  return fit;
}

const RING_EDGES = 24;
const TAPER = [
  { at: 0, radius: 60 },
  { at: 1, radius: 30 },
];
const WAIST = [
  { at: 0, radius: 60 },
  { at: 0.5, radiusX: 50, radiusY: 40 },
  { at: 1, radius: 30 },
];

describe('fitted variable sweeps break at their interior stations', () => {
  it('an interior station costs one run, not a finer fit of the whole path', () => {
    const taper = fitted(TAPER);
    const waist = fitted(WAIST);
    // 3 path segments (curvature breaks) = 3 runs; the station at 0.5 adds one run: 4 runs x 24 edges, within the fit tolerance
    expect(taper.faces).toHaveLength(3 * RING_EDGES);
    expect(waist.faces).toHaveLength(4 * RING_EDGES);
    expect(waist.cells).toBeLessThanOrEqual(2 * taper.cells);
  });

  it('a linear blend (a C0 kink at the station) fits as cheaply', () => {
    const linear = fitted(WAIST, { stationBlend: 'linear' });
    expect(linear.faces).toHaveLength(4 * RING_EDGES);
  });
});
