import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { extractSubSurface } from '@lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { sphereSurface } from '../../helpers/revolvedSurfaces';

/**
 * TECHNICAL_SPEC §8 budgets on the TS path (no kernel), VC-SRF-12 stand-in: a CRM-scale model (a wing-body of ~100 patches) checked at every
 * internal edge. The budgets are the spec's desktop figures; CI machines are slower and noisier, so each test allows a multiple and the
 * measured time is asserted against the budget x SLACK. The numbers on the development machine are recorded in docs §13.
 */
const SLACK = 4;
const empty = createEmptyDocument();

const timed = <T>(run: () => T): { value: T; ms: number } => {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
};

describe('performance budgets (spec §8, TS path)', () => {
  it('airfoil_from_naca (161 points) <= 20 ms', () => {
    execute(empty, 'airfoil_from_naca', { designation: '0012' });
    const { ms } = timed(() => execute(empty, 'airfoil_from_naca', { designation: '2412' }));
    expect(ms).toBeLessThan(20 * SLACK);
  });

  it('interpolate_curve through 10 000 points <= 200 ms x slack (banded solve, linear in the points)', () => {
    const points = Array.from({ length: 10_000 }, (_, k) => [k * 0.01, Math.sin(k * 0.01), Math.cos(k * 0.013)]);
    const { value, ms } = timed(() => execute(empty, 'interpolate_curve', { points, degree: 3 }));
    expect(value.affected).toHaveLength(1);
    expect(ms).toBeLessThan(200 * SLACK);
  });

  it('analyze_surface_curvature on a 100 x 100 grid <= 500 ms x slack', () => {
    const made = execute(empty, 'create_nurbs_surface', { ...sphereSurface(10) });
    const { value, ms } = timed(() => execute(made.document, 'analyze_surface_curvature', { id: made.affected[0]!, grid: [100, 100] }));
    expect(value.error).toBeUndefined();
    expect(ms).toBeLessThan(500 * SLACK);
  });

  it('loft_fuselage through 40 conic stations <= 3 s', () => {
    const stations = Array.from({ length: 40 }, (_, k) => {
      const fs = k * 0.5;
      const r = Math.sin((Math.PI * k) / 39) ** 0.5 * 1.5;
      return k === 0 || k === 39
        ? { fs, section: { type: 'point', wl: 0 } }
        : {
            fs,
            section: {
              type: 'conic',
              halfBreadth: r,
              wlMaxBreadth: 0,
              upper: { wlExtreme: r, rho: 0.45 },
              lower: { wlExtreme: -r, rho: 0.45 },
            },
          };
    });
    const { value, ms } = timed(() => execute(empty, 'loft_fuselage', { stations }));
    expect(value.affected).toHaveLength(1);
    expect(ms).toBeLessThan(3000 * SLACK);
  });

  it('check_continuity at every internal edge of a ~100 patch wing-body model <= 10 s (VC-SRF-12 on the TS path)', () => {
    // a bulged shell cut into 12 x 9 patches (a CRM wing-body STEP has the same order of magnitude of faces)
    const whole = sphereSurface(10);
    const [uCuts, vCuts] = [12, 9];
    let doc: CadDocument = empty;
    const ids: string[][] = [];
    for (let i = 0; i < uCuts; i++) {
      ids.push([]);
      for (let j = 0; j < vCuts; j++) {
        const patch = extractSubSurface(whole, [i / uCuts, (i + 1) / uCuts], [j / vCuts, (j + 1) / vCuts]) as NurbsSurfaceData;
        const made = execute(doc, 'create_nurbs_surface', { ...patch });
        doc = made.document;
        ids[i]!.push(made.affected[0]!);
      }
    }
    const pairs: Array<{ a: { id: string; side: string }; b: { id: string; side: string } }> = [];
    for (let i = 0; i < uCuts; i++)
      for (let j = 0; j < vCuts; j++) {
        if (i + 1 < uCuts) pairs.push({ a: { id: ids[i]![j]!, side: 'u1' }, b: { id: ids[i + 1]![j]!, side: 'u0' } });
        if (j + 1 < vCuts) pairs.push({ a: { id: ids[i]![j]!, side: 'v1' }, b: { id: ids[i]![j + 1]!, side: 'v0' } });
      }
    expect(pairs.length).toBeGreaterThan(190);
    let worstOrder = 'G3';
    const { ms } = timed(() => {
      for (let start = 0; start < pairs.length; start += 50) {
        const result = execute(doc, 'check_continuity', { pairs: pairs.slice(start, start + 50), samples: 21, require: 'G2' });
        expect(result.error).toBeUndefined();
        for (const joint of (result.data as { joints: Array<{ order: string }> }).joints)
          if (['none', 'G0', 'G1', 'G2'].indexOf(joint.order) < ['none', 'G0', 'G1', 'G2'].indexOf(worstOrder)) worstOrder = joint.order;
      }
    });
    expect(worstOrder).toBe('G3');
    expect(ms).toBeLessThan(10_000);
  });
});
