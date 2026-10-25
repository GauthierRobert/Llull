/** DES-2c: hollow round sections with laws are fitted (outer faces + bore faces on the same stations and laws) instead of being refused. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';
import { constantEdges } from '@core/geometry/sweepEval/sectionEdges';
import { evaluateSurface } from '@lib/nurbs/surface';
import { relError } from '../../helpers/swgPack';

function sweep(params: Record<string, unknown>): SweepEntity {
  const made = execute(createEmptyDocument(), 'sweep_profile', params);
  expect(made.affected, made.summary).toHaveLength(1);
  return made.document.entities[made.affected[0] as string] as SweepEntity;
}

const bar = [
  [0, 0, 0],
  [0, 0, 100],
];

/** Largest relative gap between the radius of every sampled surface point about the z axis and `radiusAt(z)`. */
function radiusError(surfaces: ReadonlyArray<Parameters<typeof evaluateSurface>[0]>, radiusAt: (z: number) => number): number {
  let worst = 0;
  for (const surface of surfaces)
    for (const u of [0.1, 0.5, 0.9])
      for (const v of [0, 0.3, 0.77, 1]) {
        const point = evaluateSurface(surface, u, v);
        worst = Math.max(worst, relError(Math.hypot(point[0], point[1]), radiusAt(point[2])));
      }
  return worst;
}

describe('fitSweepFaces: memoised per entity and tolerance', () => {
  it('returns the same fit for the same entity object and tolerance, and a new one for another tolerance or entity', () => {
    const entity = sweep({ path: bar, radius: 4, scale: { type: 'linear', start: 1, end: 0.5 } });
    const first = fitSweepFaces(entity, 1e-6);
    expect(fitSweepFaces(entity, 1e-6)).toBe(first);
    expect(fitSweepFaces(entity, 1e-5)).not.toBe(first);
    expect(fitSweepFaces({ ...entity }, 1e-6)).not.toBe(first);
  });
});

describe('fitSweepFaces: a hollow round section', () => {
  it('a scale law scales wall and bore alike: both face sets hold their radius times the law', () => {
    const entity = sweep({ path: bar, radius: 4, innerRadius: 2, scale: { type: 'linear', start: 1, end: 0.5 } });
    const fit = fitSweepFaces(entity, fitToleranceOf(entity));
    expect('faces' in fit).toBe(true);
    if (!('faces' in fit)) return;
    expect(fit.bore).toBeDefined();
    expect(fit.bore?.surfaces.length).toBe(fit.surfaces.length);
    expect(fit.bore?.faces.length).toBe(fit.faces.length);
    expect(fit.deviation).toBeLessThanOrEqual(fitToleranceOf(entity));
    const scale = (z: number): number => 1 - 0.5 * (z / 100);
    expect(radiusError(fit.surfaces, (z) => 4 * scale(z))).toBeLessThan(1e-6);
    expect(radiusError(fit.bore?.surfaces ?? [], (z) => 2 * scale(z))).toBeLessThan(1e-6);
  });
  it('an area law gives wall and bore one scale, sqrt(A(t) / A(hollow)): the annulus area follows the law', () => {
    const entity = sweep({ path: bar, radius: 4, innerRadius: 2, area: { type: 'linear', start: 12 * Math.PI, end: 3 * Math.PI } });
    const fit = fitSweepFaces(entity, fitToleranceOf(entity));
    if (!('faces' in fit)) throw new Error(fit.message);
    const scale = (z: number): number => Math.sqrt(1 - 0.75 * (z / 100));
    expect(radiusError(fit.surfaces, (z) => 4 * scale(z))).toBeLessThan(1e-6);
    expect(radiusError(fit.bore?.surfaces ?? [], (z) => 2 * scale(z))).toBeLessThan(1e-6);
  });
  it('a solid round section has no bore faces, and a degenerate arc is still refused', () => {
    const solid = sweep({ path: bar, radius: 4, scale: { type: 'linear', start: 1, end: 0.5 } });
    const fit = fitSweepFaces(solid, fitToleranceOf(solid));
    expect('faces' in fit && fit.bore).toBeFalsy();
    const degenerate: SweepEntity = {
      ...solid,
      section: {
        shape: 'profile',
        profile: [
          [0, 0],
          [1, 0],
          [2, 0],
        ],
        curves: [
          {
            type: 'arc',
            points: [
              [0, 0],
              [1, 0],
              [2, 0],
            ],
          },
        ],
      },
    };
    expect(constantEdges(degenerate.section)).toBeNull();
    expect(fitSweepFaces(degenerate, 1e-6)).toMatchObject({ code: 'SWG_FIT_UNSUPPORTED' });
  });
  it('check_sweep_loft reports the fit of a hollow tube with laws as an info finding, not a mesh-only warning', () => {
    const made = execute(createEmptyDocument(), 'sweep_profile', {
      path: bar,
      radius: 4,
      innerRadius: 2,
      scale: { type: 'linear', start: 1, end: 0.5 },
    });
    const check = execute(made.document, 'check_sweep_loft', { ids: made.affected });
    const findings = (check.data as { findings: Array<{ code: string; severity: string; message: string }> }).findings;
    expect(findings.find((f) => f.code === 'SWG_CHECK_FIT_APPROXIMATION')).toMatchObject({ severity: 'info' });
  });
});
