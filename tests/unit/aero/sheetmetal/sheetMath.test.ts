import { describe, expect, it } from 'vitest';
import {
  FAA_K_EQUIVALENT,
  FORMULAS,
  bendQuantities,
  dinToAnsiK,
  faaBendQuantities,
  joggleQuantities,
  kFromTable,
  minJoggleOffset,
} from '@aero/sheetmetal/sheetMath';
import expected from '../../../../docs/aerospace/07-sheet-metal-machined-features/validation/data/expected_flat_pattern.json';

const rad = (degrees: number): number => (degrees * Math.PI) / 180;

describe('bend quantities (VC-FTR-01, 02, 04, 35)', () => {
  it.each(expected.bends)('$id reproduces BA, OSSB, ISSB, BD and the K-chart value', (row) => {
    const tolerance = row.units === 'mm' ? 1e-6 : 1e-7;
    const q = bendQuantities({ theta: rad(row.theta_deg), insideRadius: row.R, thickness: row.T, k: row.K_ansi });
    expect(Math.abs(q.ba.value - row.BA)).toBeLessThan(tolerance);
    expect(Math.abs(q.ossb.value - row.OSSB)).toBeLessThan(tolerance);
    expect(Math.abs(q.issb.value - row.ISSB)).toBeLessThan(tolerance);
    expect(Math.abs(q.bd.value - row.BD)).toBeLessThan(tolerance);
    expect(Math.abs(q.kChart.value - row.K_chart_tan_half)).toBeLessThan(1e-9);
    expect(q.rOverT.value).toBeCloseTo(row.R_over_T, 12);
  });

  it.each(expected.bends.filter((row) => row.flat_length !== null))('$id flat length = A + B - BD', (row) => {
    const q = bendQuantities({ theta: rad(row.theta_deg), insideRadius: row.R, thickness: row.T, k: row.K_ansi });
    expect(Math.abs((row.A_mold as number) + (row.B_mold as number) - q.bd.value - (row.flat_length as number))).toBeLessThan(1e-6);
  });

  it('carries the formula id of every value (TR-FTR-09)', () => {
    const q = bendQuantities({ theta: Math.PI / 2, insideRadius: 1, thickness: 1, k: 0.4 });
    expect(q.ossb.formula).toBe('tan(theta/2)*(R+T)');
    expect(q.ba.formula).toBe(FORMULAS.ba);
    expect(Object.values(q).every((entry) => entry.formula.length > 0)).toBe(true);
  });

  it('is scale invariant between inch and mm (VC-FTR-35)', () => {
    const inch = bendQuantities({ theta: rad(135), insideRadius: 0.25, thickness: 0.064, k: 0.4475 });
    const mm = bendQuantities({ theta: rad(135), insideRadius: 0.25 * 25.4, thickness: 0.064 * 25.4, k: 0.4475 });
    for (const key of ['ba', 'ossb', 'issb', 'bd'] as const) expect(mm[key].value / inch[key].value).toBeCloseTo(25.4, 9);
  });
});

describe('FAA empirical mode (VC-FTR-03)', () => {
  it('gives 0.28017 in for the EAA example', () => {
    const q = faaBendQuantities({ theta: rad(60), insideRadius: 0.25, thickness: 0.04 });
    expect(q.ba.value).toBeCloseTo(0.28017, 7);
    expect(Math.abs(q.ba.value - 0.2796)).toBeLessThan(0.0007);
    expect(q.ba.formula).toBe(FORMULAS.baFaa);
    expect(q.bd.value).toBeCloseTo(2 * q.ossb.value - q.ba.value, 12);
    expect(FAA_K_EQUIVALENT).toBeCloseTo(0.4475, 3);
  });
});

describe('K-factor conversions (VC-FTR-05)', () => {
  it('converts DIN to ANSI', () => {
    expect(dinToAnsiK(0.88).value).toBeCloseTo(0.44, 12);
  });
  it('interpolates a table and clamps at both ends', () => {
    const table = [
      { rOverT: 3, k: 0.44 },
      { rOverT: 1, k: 0.4 },
    ];
    expect(kFromTable(table, 2).value).toBeCloseTo(0.42, 12);
    expect(kFromTable(table, 0.5).value).toBeCloseTo(0.4, 12);
    expect(kFromTable(table, 9).value).toBeCloseTo(0.44, 12);
    expect(kFromTable(table, 3).value).toBeCloseTo(0.44, 12);
    expect(kFromTable([{ rOverT: 1, k: 0.4 }], 5).value).toBe(0.4);
    expect(kFromTable([], 1).value).toBeNaN();
  });
  it('handles two rows with the same r/T', () => {
    const table = [
      { rOverT: 1, k: 0.3 },
      { rOverT: 1, k: 0.4 },
      { rOverT: 2, k: 0.5 },
    ];
    expect(Number.isFinite(kFromTable(table, 1.5).value)).toBe(true);
  });
});

describe('joggle (VC-FTR-11, 11b)', () => {
  it.each(expected.joggles.filter((row) => row.valid))('$id matches straight, run and allowance', (row) => {
    const j = joggleQuantities({ thickness: row.T, insideRadius: row.R, k: row.K_ansi, phi: rad(row.phi_deg), offset: row.offset_h });
    expect(j).not.toBeNull();
    expect(Math.abs((j?.inclinedStraight.value ?? 0) - (row.inclined_straight as number))).toBeLessThan(1e-6);
    expect(Math.abs((j?.run.value ?? 0) - (row.run as number))).toBeLessThan(1e-6);
    expect(Math.abs((j?.developed.value ?? 0) - (row.developed as number))).toBeLessThan(1e-6);
    expect(Math.abs((j?.allowance.value ?? 0) - (row.allowance as number))).toBeLessThan(1e-6);
  });
  it('rejects JG-04 (offset too small) and bad angles', () => {
    const jg04 = expected.joggles.find((row) => row.id === 'JG-04');
    expect(jg04?.valid).toBe(false);
    expect(joggleQuantities({ thickness: 1.6, insideRadius: 6, k: 0.44, phi: rad(45), offset: 0.5 })).toBeNull();
    expect(joggleQuantities({ thickness: 1.6, insideRadius: 6, k: 0.44, phi: 0, offset: 5 })).toBeNull();
    expect(joggleQuantities({ thickness: 1.6, insideRadius: 6, k: 0.44, phi: rad(120), offset: 5 })).toBeNull();
    expect(minJoggleOffset(1.6, 6, rad(45))).toBeGreaterThan(0.5);
  });
  it('accepts the exact minimum offset (s = 0)', () => {
    const offset = minJoggleOffset(1.6, 1.6, rad(20));
    expect(joggleQuantities({ thickness: 1.6, insideRadius: 1.6, k: 0.44, phi: rad(20), offset })?.inclinedStraight.value).toBeCloseTo(
      0,
      9,
    );
  });
});
