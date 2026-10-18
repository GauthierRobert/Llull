import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import {
  betaOf,
  netYieldSize,
  netYieldStress,
  newmanRajuF,
  newmanRajuQ,
  sizeLimit,
  solvedGeometry,
  validityOf,
  type SolvedGeometry,
} from '@cae/fracture/kSolutions';
import { expectedValue } from '../fatigue/support';
import { code, data, mm, relative } from './support';

const PACK = '08-fracture-damage-tolerance';
const center = (a: number, W: number): SolvedGeometry => ({ kind: 'center_through', a, W, t: 0.002 });
const edge = (a: number, b: number, form: 'tada' | 'polynomial'): SolvedGeometry => ({ kind: 'edge_through', a, b, t: 0.002, form });

describe('K solutions', () => {
  it('VC-FRC-01: centre crack a 10 mm, W 100 mm, 100 MPa gives K = 18.1748892684 MPa sqrt(m)', () => {
    const K = betaOf(center(0.01, 0.1)) * 100 * Math.sqrt(Math.PI * 0.01);
    expect(relative(K, expectedValue(PACK, 'VC-FRC-01') as number)).toBeLessThan(1e-11);
  });

  it('VC-FRC-02: edge crack beta at a/b = 0.5 for Tada and the polynomial', () => {
    const expected = expectedValue(PACK, 'VC-FRC-02') as Record<string, number>;
    expect(relative(betaOf(edge(0.5, 1, 'tada')), expected['tada'] ?? 0)).toBeLessThan(1e-11);
    expect(relative(betaOf(edge(0.5, 1, 'polynomial')), expected['polynomial'] ?? 0)).toBeLessThan(1e-11);
  });

  it('the two edge forms agree within 1 % for 0.1 <= a/b <= 0.6', () => {
    for (let r = 0.1; r <= 0.6001; r += 0.1)
      expect(relative(betaOf(edge(r, 1, 'polynomial')), betaOf(edge(r, 1, 'tada')))).toBeLessThan(0.01);
  });

  it('VC-FRC-04 (grade C): Newman-Raju Q and F at the deepest and surface points', () => {
    const expected = expectedValue(PACK, 'VC-FRC-04') as Record<string, { Q: number; F_deepest: number; F_surface: number }>;
    for (const aOverC of [0.2, 0.4, 1]) {
      const row = expected[`a_c=${aOverC.toFixed(1)}`];
      expect(relative(newmanRajuQ(aOverC), row?.Q ?? 0)).toBeLessThan(1e-9);
      expect(relative(newmanRajuF(aOverC, 0.5, 0.1, Math.PI / 2), row?.F_deepest ?? 0)).toBeLessThan(1e-9);
      expect(relative(newmanRajuF(aOverC, 0.5, 0.1, 0), row?.F_surface ?? 0)).toBeLessThan(1e-9);
    }
    const surface: SolvedGeometry = { kind: 'surface_semi_elliptical', a: 0.005, c: 0.01, t: 0.01, b: 0.05 };
    expect(betaOf(surface)).toBeCloseTo(newmanRajuF(0.5, 0.5, 0.2, Math.PI / 2) / Math.sqrt(newmanRajuQ(0.5)), 12);
  });

  it('net-section helpers: centre sigma W / (W - 2a) = Fty at a = W/2 (1 - sigma/Fty); edge and surface variants', () => {
    expect(netYieldSize(center(0.01, 0.2), 150, 300)).toBeCloseTo(0.05, 12);
    expect(netYieldStress(center(0.01, 0.2), 0.01, 300)).toBeCloseTo(270, 10);
    expect(netYieldSize(edge(0.01, 0.1, 'tada'), 150, 300)).toBeCloseTo(0.05, 12);
    expect(netYieldStress(edge(0.01, 0.1, 'tada'), 0.01, 300)).toBeCloseTo(270, 10);
    const surface: SolvedGeometry = { kind: 'surface_semi_elliptical', a: 0.005, c: 0.01, t: 0.01, b: 0.05 };
    expect(netYieldSize(surface, 100, 300)).toBeNull();
    expect(netYieldStress(surface, 0.005, 300)).toBeNull();
  });

  it('validity limits and size bounds', () => {
    expect(validityOf(center(0.04, 0.1)).inRange).toBe(true);
    expect(validityOf(center(0.045, 0.1)).inRange).toBe(false);
    expect(validityOf(edge(0.7, 1, 'polynomial')).inRange).toBe(false);
    expect(validityOf(edge(0.7, 1, 'tada')).inRange).toBe(true);
    expect(sizeLimit(center(0.01, 0.2))).toBeCloseTo(0.08, 12);
    expect(sizeLimit(edge(0.01, 0.2, 'polynomial'))).toBeCloseTo(0.12, 12);
    expect(sizeLimit({ kind: 'surface_semi_elliptical', a: 0.005, c: 0.01, t: 0.01, b: 0.05 })).toBeCloseTo(0.008, 12);
    expect(validityOf({ kind: 'surface_semi_elliptical', a: 0.005, c: 0.01, t: 0.01, b: 0.05 }).inRange).toBe(true);
  });

  it('solvedGeometry converts units and reports bad geometry', () => {
    const geometry = solvedGeometry({ kind: 'center_through', a: { value: 0.5, unit: 'in' }, W: { value: 8, unit: 'in' }, t: mm(2) });
    expect(typeof geometry === 'string' ? 0 : geometry.a).toBeCloseTo(0.0127, 12);
    expect(solvedGeometry({ kind: 'center_through', a: mm(60), W: mm(100), t: mm(2) })).toMatch(/W\/2/);
    expect(solvedGeometry({ kind: 'center_through', a: mm(-1), W: mm(100), t: mm(2) })).toMatch(/length/);
    expect(solvedGeometry({ kind: 'center_through', a: { value: 1, unit: 'MPa' }, W: mm(100), t: mm(2) })).toMatch(/length/);
    expect(solvedGeometry({ kind: 'edge_through', a: mm(10), b: mm(5), t: mm(2), form: 'tada' })).toMatch(/a must be < b/);
    expect(solvedGeometry({ kind: 'surface_semi_elliptical', a: mm(5), c: mm(2), t: mm(10), b: mm(50) })).toMatch(/a\/c/);
    expect(solvedGeometry({ kind: 'surface_semi_elliptical', a: mm(12), c: mm(20), t: mm(10), b: mm(50) })).toMatch(/a must be < t/);
  });
});

describe('stress_intensity command', () => {
  const geometry = { kind: 'center_through', a: mm(10), W: mm(100), t: mm(2) };

  it('VC-FRC-01: inline geometry, 100 MPa, with provenance and the not-approved note', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'stress_intensity', { geometry, stress: { value: 100, unit: 'MPa' } });
    expect(relative(data(result)['KMPaSqrtM'] as number, expectedValue(PACK, 'VC-FRC-01') as number)).toBeLessThan(1e-11);
    expect(data(result)).toMatchObject({ reviewRequired: true, validity: { inRange: true } });
    expect(result.summary).toContain('not approved');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('a stored crack and a ksi stress give the same K', () => {
    const crack = execute(createEmptyDocument(), 'define_crack', { name: 'c', geometry });
    const stored = execute(crack.document, 'stress_intensity', { crackId: crack.affected[0], stress: { value: 100, unit: 'MPa' } });
    const ksi = execute(crack.document, 'stress_intensity', {
      crackId: crack.affected[0],
      stress: { value: 100 / 6.894757293168361, unit: 'ksi' },
    });
    expect(relative(data(ksi)['KMPaSqrtM'] as number, data(stored)['KMPaSqrtM'] as number)).toBeLessThan(1e-9);
  });

  it('surface cracks return an unconfirmed-solution item; phiDeg selects the surface point', () => {
    const surface = { kind: 'surface_semi_elliptical', a: mm(5), c: mm(10), t: mm(10), b: mm(50) };
    const deepest = data(execute(createEmptyDocument(), 'stress_intensity', { geometry: surface, stress: { value: 100, unit: 'MPa' } }));
    const atSurface = data(
      execute(createEmptyDocument(), 'stress_intensity', { geometry: surface, stress: { value: 100, unit: 'MPa' }, phiDeg: 0 }),
    );
    expect((deepest['items'] as Array<{ code: string }>).map((i) => i.code)).toEqual(['FRC_K_SOLUTION_UNCONFIRMED']);
    expect(deepest['unverified']).toBe(true);
    expect(atSurface['KMPaSqrtM']).not.toBe(deepest['KMPaSqrtM']);
  });

  it.each([
    ['neither crackId nor geometry', {}, 'FRC_PARAMS_INVALID'],
    ['both', { crackId: 'x', geometry }, 'FRC_PARAMS_INVALID'],
    ['unknown crack', { crackId: 'nope' }, 'FRC_CRACK_NOT_FOUND'],
    ['bad geometry', { geometry: { ...geometry, a: mm(80) } }, 'FRC_CRACK_INVALID'],
    ['bad stress unit', { geometry, stress: { value: 1, unit: 'mm' } }, 'FRC_PARAMS_INVALID'],
    ['outside validity (a/W 0.45)', { geometry: { ...geometry, a: mm(45) } }, 'FRC_K_SOLUTION_OUT_OF_RANGE'],
  ])('refuses %s', (_label, params, expected) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'stress_intensity', { stress: { value: 100, unit: 'MPa' }, ...params });
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(doc);
  });
});
