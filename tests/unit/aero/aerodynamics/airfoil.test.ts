import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type PolylineEntity } from '@core/model/types';
import refs from '../../../../docs/aerospace/10-aerodynamics/validation/data/airfoil_wing_references.json';
import { readFileSync } from 'node:fs';
import { data, expectRefusal, ok } from '../sheetmetal/helpers';

interface Polar {
  polar: Array<{ alphaDeg: number; cl: number; clCirculation: number; cm: number; cdPressure: number }>;
  liftSlopePerDeg?: number;
  zeroLiftAngleDeg?: number;
  thinAirfoil?: { zeroLiftAngleDeg: number; cmQuarterChord: number };
  surface?: Array<{ alphaDeg: number; points: Array<{ cp: number }> }>;
  airfoil: { panels: number; chord: number };
}

const doc = createEmptyDocument();

/** Joukowski airfoil ordinates (circle radius R centred at (-mx, my) through ζ = b, z = ζ + b²/ζ) and its exact cl. */
function joukowski(b: number, mx: number, my: number, alphaDeg: number, n: number): { points: number[][]; cl: number } {
  const radius = Math.hypot(b + mx, my);
  const beta = Math.asin(my / radius);
  const points = Array.from({ length: n }, (_, k) => {
    const t = -beta - (2 * Math.PI * k) / n;
    const zx = -mx + radius * Math.cos(t);
    const zy = my + radius * Math.sin(t);
    const r2 = zx * zx + zy * zy;
    return [zx + (b * b * zx) / r2, zy - (b * b * zy) / r2];
  });
  const xs = points.map(([x]) => x as number);
  const chord = Math.max(...xs) - Math.min(...xs);
  return { points, cl: (8 * Math.PI * radius * Math.sin((alphaDeg * Math.PI) / 180 + beta)) / chord };
}

describe('analyze_airfoil (VC-AER-10..12)', () => {
  it.each(refs.joukowski.cases)(
    'Joukowski b $b, centre (-$mx, $my), α $alphaDeg°: panel cl within 1 % of the exact potential-flow lift',
    (c) => {
      const shape = joukowski(c.b, c.mx, c.my, c.alphaDeg, 2 * refs.joukowski.acceptance.panelsPerSide);
      const drawn = ok(doc, 'draw_polyline', { points: shape.points, closed: true });
      const id = drawn.affected[0] as string;
      const result = data<Polar>(drawn.document, 'analyze_airfoil', { entityId: id, alphasDeg: [c.alphaDeg] });
      const row = result.polar[0] as Polar['polar'][0];
      expect(Math.abs(row.cl - shape.cl)).toBeLessThan(refs.joukowski.acceptance.clRel * Math.max(Math.abs(shape.cl), 0.05));
      expect(Math.abs(row.clCirculation - shape.cl)).toBeLessThan(refs.joukowski.acceptance.clRel * Math.max(Math.abs(shape.cl), 0.05));
    },
  );

  it('NACA 2412 thin-airfoil zero-lift angle is -2.077° and the panel α_L0 is near it', () => {
    const result = data<Polar>(doc, 'analyze_airfoil', { naca: '2412', alphasDeg: [-2, 0, 2, 4] });
    expect(result.thinAirfoil?.zeroLiftAngleDeg).toBeCloseTo(refs.naca2412_thin_airfoil.zeroLiftAngleDeg, 3);
    expect(Math.abs((result.zeroLiftAngleDeg as number) - refs.naca2412_thin_airfoil.experimentalZeroLiftDeg)).toBeLessThan(0.4);
    expect(result.thinAirfoil?.cmQuarterChord).toBeLessThan(0);
  });

  it('NACA 0012 is symmetric, inviscid lift exceeds the Ladson / McCroskey data by the documented 5-15 %', () => {
    const result = data<Polar>(doc, 'analyze_airfoil', { naca: '0012', alphasDeg: [0, 5, 10] });
    expect(Math.abs(result.polar[0]?.cl as number)).toBeLessThan(1e-9);
    expect(Math.abs(result.polar[1]?.cm as number)).toBeLessThan(0.01);
    const ratio = (result.liftSlopePerDeg as number) / refs.naca0012_mccroskey.liftSlopePerDegAtRe6e6;
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(1.15);
    const [low, high] = refs.naca0012_ladson.points[1]?.clRange as number[];
    const cl10 = result.polar[2]?.cl as number;
    expect(cl10 / (high as number)).toBeGreaterThan(1.05);
    expect(cl10 / (low as number)).toBeLessThan(1.15);
  });

  it('converges: integrated and circulation lift agree, pressure drag tends to zero', () => {
    const coarse = data<Polar>(doc, 'analyze_airfoil', { naca: '4412', alphasDeg: [4], panelsPerSide: 40 });
    const fine = data<Polar>(doc, 'analyze_airfoil', { naca: '4412', alphasDeg: [4], panelsPerSide: 200, includeSurface: true });
    const [c, f] = [coarse.polar[0], fine.polar[0]] as [Polar['polar'][0], Polar['polar'][0]];
    expect(Math.abs(f.cl - f.clCirculation)).toBeLessThan(Math.abs(c.cl - c.clCirculation));
    expect(Math.abs(f.cdPressure)).toBeLessThan(Math.abs(c.cdPressure));
    expect(Math.abs(f.cdPressure)).toBeLessThan(2e-3);
    expect(fine.surface?.[0]?.points.length).toBe(fine.airfoil.panels);
    expect(Math.max(...(fine.surface?.[0]?.points.map((point) => point.cp) ?? []))).toBeCloseTo(1, 1);
  });

  it('draw_naca_airfoil reproduces the 02 SRF NACA 2412 ordinates (validated against UIUC) and is pure', () => {
    const before = structuredClone(doc);
    const drawn = ok(doc, 'draw_naca_airfoil', { naca: '2412', chord: 1, pointsPerSide: 80, closedTrailingEdge: false });
    expect(doc).toEqual(before);
    const entity = drawn.document.entities[drawn.affected[0] as string] as PolylineEntity;
    expect(entity.kind).toBe('polyline');
    expect(entity.closed).toBe(true);
    const csv = readFileSync(
      new URL('../../../../docs/aerospace/02-advanced-surfacing/validation/data/naca_2412_selig_81.csv', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(',').map(Number) as [number, number]);
    expect(entity.points.length).toBe(csv.length);
    entity.points.forEach(([x, y], index) => {
      const [rx, ry] = csv[index] as [number, number];
      expect(Math.hypot(x - rx, y - ry)).toBeLessThan(1e-7);
    });
    const analysed = data<Polar>(drawn.document, 'analyze_airfoil', { entityId: drawn.affected[0], alphasDeg: [0, 4] });
    const direct = data<Polar>(doc, 'analyze_airfoil', { naca: '2412', alphasDeg: [0, 4], panelsPerSide: 80, closedTrailingEdge: false });
    expect(analysed.polar[1]?.cl).toBeCloseTo(direct.polar[1]?.cl as number, 2);
  });

  it('incidence rotates the section nose-up about the leading edge', () => {
    const drawn = ok(doc, 'draw_naca_airfoil', { naca: '0012', chord: 100, incidenceDeg: 10, position: [5, 0, 0] });
    const entity = drawn.document.entities[drawn.affected[0] as string] as PolylineEntity;
    const trailing = entity.points[0] as [number, number];
    expect(trailing[1]).toBeCloseTo(-100 * Math.sin((10 * Math.PI) / 180), 4);
    expect(drawn.summary).toContain('NACA 0012');
  });

  it('refuses bad sources, designations and angles', () => {
    expectRefusal(doc, 'analyze_airfoil', {}, 'AER_AIRFOIL_SOURCE_CONFLICT');
    expectRefusal(doc, 'analyze_airfoil', { naca: '0012', entityId: 'x' }, 'AER_AIRFOIL_SOURCE_CONFLICT');
    expectRefusal(doc, 'analyze_airfoil', { naca: '21012' }, 'AER_AIRFOIL_INVALID', 'naca');
    expectRefusal(doc, 'analyze_airfoil', { naca: '0000' }, 'AER_AIRFOIL_INVALID');
    expectRefusal(doc, 'analyze_airfoil', { naca: '2012' }, 'AER_AIRFOIL_INVALID');
    expectRefusal(doc, 'analyze_airfoil', { naca: 'abc' }, 'AER_AIRFOIL_INVALID');
    expectRefusal(doc, 'analyze_airfoil', { entityId: 'nope' }, 'AER_AIRFOIL_INVALID', 'entityId');
    expectRefusal(doc, 'analyze_airfoil', { naca: '0012', alphasDeg: [30] }, 'AER_PARAM_INVALID', 'alphasDeg');
    expectRefusal(doc, 'analyze_airfoil', { naca: '0012', panelsPerSide: 5 }, 'AER_PARAM_INVALID', 'panelsPerSide');
    expectRefusal(doc, 'draw_naca_airfoil', { naca: '9', chord: 1 }, 'AER_AIRFOIL_INVALID');
    expectRefusal(doc, 'draw_naca_airfoil', { naca: '0012', chord: 0 }, 'AER_PARAM_INVALID');
    const line = ok(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      closed: true,
    });
    expectRefusal(line.document, 'analyze_airfoil', { entityId: line.affected[0] }, 'AER_AIRFOIL_INVALID');
  });

  it('accepts a 230-series section and a single angle (no lift fit)', () => {
    const result = data<Polar>(doc, 'analyze_airfoil', { naca: 'NACA 23012', alphasDeg: [2] });
    expect(result.liftSlopePerDeg).toBeUndefined();
    expect(result.thinAirfoil?.zeroLiftAngleDeg).toBeLessThan(-1);
  });
});
