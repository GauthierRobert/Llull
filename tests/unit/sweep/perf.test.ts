/** SWG performance budgets (TECHNICAL_SPEC 8, VC-SWG-33) with four times the slack of the desktop figures. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type SweepEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { evaluateSweep } from '@core/geometry/sweepEval/evaluate';
import { fitSweepFaces, fitToleranceOf } from '@core/geometry/sweepEval/fitted';
import { sweepTriangles } from '@core/geometry/sweep';

const empty = createEmptyDocument();
const time = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

describe('SWG performance budgets x4', () => {
  const twisted = execute(empty, 'sweep_profile', {
    path: [
      [0, 0, 0],
      [0, 0, 200],
    ],
    section: [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
    ],
    twist: { type: 'linear', start: 0, end: 12 },
    scale: { type: 'expression', expression: '1 + 0.2*sin(8*t)' },
  });
  const entity = twisted.document.entities[twisted.affected[0] as string] as SweepEntity;
  it('frames + laws at 2 000 samples: 30 ms x 4', () => {
    expect(time(() => evaluateSweep(entity)).ms).toBeLessThan(120);
  });
  it('a sweep with laws as a display mesh: 300 ms x 4', () => {
    expect(time(() => sweepTriangles(entity)).ms).toBeLessThan(1200);
  });
  it('the fitted faces of a twisted sweep: 500 ms x 4', () => {
    const { value, ms } = time(() => fitSweepFaces(entity, fitToleranceOf(entity)));
    expect('faces' in value).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
  it('add_helix, 200 turns at 1e-6 R: 200 ms x 4', () => {
    const { value, ms } = time(() => execute(empty, 'add_helix', { radius: 20, pitch: 5, turns: 200 }));
    expect(value.affected).toHaveLength(1);
    expect(ms).toBeLessThan(800);
  });
  it('check_sweep_loft on a 10-turn helical sweep: 1 s x 4', () => {
    const helix = execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 10 });
    const swept = execute(helix.document, 'sweep_profile', { pathId: helix.affected[0], radius: 2 });
    const { value, ms } = time(() => execute(swept.document, 'check_sweep_loft', { ids: swept.affected }));
    expect((value.data as { status: string }).status).toBe('pass');
    expect(ms).toBeLessThan(4000);
  });
  it('network_surface through 20 curves (10 + 10): 1 s x 4', () => {
    let doc = empty;
    const ids: string[] = [];
    const f = (x: number, y: number): number => Math.sin(2 * x) * Math.cos(y);
    for (let i = 0; i < 10; i++) {
      const y = i / 9;
      const made = execute(doc, 'interpolate_curve', {
        points: Array.from({ length: 21 }, (_, k) => [k / 20, y, f(k / 20, y)]),
        parameterization: 'uniform',
      });
      doc = made.document;
      ids.push(made.affected[0] as string);
    }
    for (let i = 0; i < 10; i++) {
      const x = i / 9;
      const made = execute(doc, 'interpolate_curve', {
        points: Array.from({ length: 21 }, (_, k) => [x, k / 20, f(x, k / 20)]),
        parameterization: 'uniform',
      });
      doc = made.document;
      ids.push(made.affected[0] as string);
    }
    const { value, ms } = time(() => execute(doc, 'network_surface', { curveIds: ids }));
    expect(value.affected, value.summary).toHaveLength(1);
    expect(ms).toBeLessThan(4000);
  });
});
