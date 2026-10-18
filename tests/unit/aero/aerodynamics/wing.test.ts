import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import refs from '../../../../docs/aerospace/10-aerodynamics/validation/data/airfoil_wing_references.json';
import { data, expectRefusal } from '../../../helpers/commandAssertions';

interface Wing {
  geometry: { area: number; aspectRatio: number; taperRatio: number | null; meanChord: number };
  polar: Array<{ alphaDeg: number; cl: number; cdi: number; spanEfficiency: number; liftN?: number; inducedDragN?: number }>;
  liftSlopePerRad: number;
  helmboldLiftSlopePerDeg: number;
  section: { zeroLiftAngleDeg: number; liftSlopeDefaulted: boolean };
  stations: Array<{ eta: number; cl: number; loading: number }>;
  warnings: string[];
}

const doc = createEmptyDocument();
const rel = refs.lifting_line.acceptance.rel;

describe('analyze_wing (VC-AER-13: Prandtl lifting line)', () => {
  it('elliptical wing: e = 1, CL_α = a0 / (1 + a0/(π AR)), CDi = CL²/(π AR) and uniform section cl', () => {
    const wing = data<Wing>(doc, 'analyze_wing', { planform: 'elliptical', span: 10, rootChord: 1.2, alphasDeg: [5] });
    const ar = wing.geometry.aspectRatio;
    expect(ar).toBeCloseTo(100 / ((Math.PI / 4) * 10 * 1.2), 6);
    const a0 = 2 * Math.PI;
    const row = wing.polar[0] as Wing['polar'][0];
    expect(Math.abs(wing.liftSlopePerRad - a0 / (1 + a0 / (Math.PI * ar))) / wing.liftSlopePerRad).toBeLessThan(rel);
    expect(Math.abs(row.cdi - row.cl ** 2 / (Math.PI * ar)) / row.cdi).toBeLessThan(rel);
    expect(row.spanEfficiency).toBeCloseTo(1, 6);
    const cls = wing.stations.map((station) => station.cl);
    expect(Math.max(...cls) - Math.min(...cls)).toBeLessThan(1e-6);
  });

  it('rectangular wing: e < 1, lift slope below the elliptical one and close to Helmbold', () => {
    const wing = data<Wing>(doc, 'analyze_wing', { span: 6, rootChord: 1, alphasDeg: [0, 4, 8] });
    expect(wing.geometry.taperRatio).toBe(1);
    expect(wing.geometry.aspectRatio).toBeCloseTo(6, 9);
    const e = wing.polar[1]?.spanEfficiency as number;
    expect(e).toBeGreaterThan(0.93);
    expect(e).toBeLessThan(0.97);
    const elliptic = (2 * Math.PI) / (1 + 2 / 6);
    expect(wing.liftSlopePerRad).toBeLessThan(elliptic);
    expect(Math.abs(wing.liftSlopePerRad * (Math.PI / 180) - wing.helmboldLiftSlopePerDeg) / wing.helmboldLiftSlopePerDeg).toBeLessThan(
      0.05,
    );
    expect(wing.section.liftSlopeDefaulted).toBe(true);
  });

  it('taper 0.4 is near-elliptic (e > 0.98); washout unloads the tip; forces with the standard atmosphere', () => {
    const tapered = data<Wing>(doc, 'analyze_wing', { span: 8, rootChord: 1.4, tipChord: 0.56, alphasDeg: [5] });
    expect(tapered.polar[0]?.spanEfficiency).toBeGreaterThan(0.98);
    const washed = data<Wing>(doc, 'analyze_wing', { span: 8, rootChord: 1.4, tipChord: 0.56, twistDeg: -3, alphasDeg: [5] });
    const tip = (rows: Wing['stations']): number => (rows[rows.length - 1] as Wing['stations'][0]).cl;
    expect(tip(washed.stations)).toBeLessThan(tip(tapered.stations));
    const forces = data<Wing>(doc, 'analyze_wing', {
      span: 8,
      rootChord: 1.4,
      tipChord: 0.56,
      alphasDeg: [5],
      speed: 50,
      altitudeM: 0,
      naca: '2412',
    });
    const row = forces.polar[0] as Wing['polar'][0];
    expect(row.liftN).toBeCloseTo(0.5 * 1.225 * 2500 * forces.geometry.area * row.cl, 0);
    expect(forces.section.zeroLiftAngleDeg).toBeCloseTo(-2.077, 2);
    const low = data<Wing>(doc, 'analyze_wing', { span: 2, rootChord: 1, alphasDeg: [5], sectionLiftSlopePerRad: 6, zeroLiftAngleDeg: -1 });
    expect(low.warnings.join(' ')).toContain('aspect ratio');
  });

  it('refuses invalid geometry and inputs', () => {
    expectRefusal(doc, 'analyze_wing', { span: 0, rootChord: 1 }, 'AER_PARAM_INVALID', 'span');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, tipChord: 2 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, terms: 1 }, 'AER_PARAM_INVALID', 'terms');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, alphasDeg: [20] }, 'AER_PARAM_INVALID', 'alphasDeg');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, sectionLiftSlopePerRad: 20 }, 'AER_PARAM_INVALID');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, naca: 'x' }, 'AER_AIRFOIL_INVALID', 'naca');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, speed: 10, altitudeM: 1e6 }, 'AER_ALTITUDE_OUT_OF_RANGE');
    expectRefusal(doc, 'analyze_wing', { span: 5, rootChord: 1, speed: 10, altitudeM: 0, densityKgM3: 1 }, 'AER_AIR_STATE_CONFLICT');
  });
});
