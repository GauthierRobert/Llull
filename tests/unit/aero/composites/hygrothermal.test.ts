import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { T300, withMaterials } from './fixtures';

const EXTRA = { alpha1: -0.3e-6, alpha2: 28e-6, beta1: 0, beta2: 0.3, GIc: 0.2, GIIc: 0.8 } as const;

interface Ply {
  angleDeg: number;
  top: { stressXyMpa: number[]; stress12Mpa: number[] };
  bottom: { stressXyMpa: number[]; stress12Mpa: number[] };
}
interface Result {
  environment: { resultants: { N: number[]; M: number[] }; freeStrain: number[]; freeCurvature: number[] };
  thermalExpansion?: { perKelvin: { strain: number[]; curvature: number[] } };
  plies: Ply[];
  firstPlyFailure: Record<string, { R: number | null; mode?: string }>;
  midplane: { strain: number[]; curvature: number[] };
}

const doc = apply(withMaterials(), 'create_lamina_material', { ...T300, name: 'HT', ...EXTRA });
const bare = apply(withMaterials(), 'create_lamina_material', { ...T300, name: 'plain' });
const run = (laminate: string, params: object = {}): Result =>
  data<Result>(doc, 'analyze_laminate', { laminate, material: 'HT', ...params });
const r = (value: number | null | undefined): number => value ?? NaN;

describe('free thermal and moisture strains (M6)', () => {
  it('lets a unidirectional laminate expand freely: strain alpha dT, no stress', () => {
    const result = run('[0_8]T', { environment: { deltaT: 100 } });
    expect(result.midplane.strain[0]).toBeCloseTo(-0.3e-6 * 100, 12);
    expect(result.midplane.strain[1]).toBeCloseTo(28e-6 * 100, 12);
    expect(result.midplane.strain[2]).toBeCloseTo(0, 12);
    for (const ply of result.plies)
      for (const stress of [...ply.top.stress12Mpa, ...ply.bottom.stress12Mpa]) expect(Math.abs(stress)).toBeLessThan(1e-6);
    expect(result.environment.resultants.N[1]).toBeGreaterThan(0);
  });

  it('reports the expansion per kelvin of the laminate; quasi-isotropic stacks expand equally in x and y without curving', () => {
    const qi = run('[0/45/-45/90]s');
    const perKelvin = qi.thermalExpansion?.perKelvin;
    expect(perKelvin?.strain[0]).toBeCloseTo(perKelvin?.strain[1] ?? NaN, 12);
    expect(perKelvin?.strain[2]).toBeCloseTo(0, 12);
    for (const value of perKelvin?.curvature ?? [1]) expect(Math.abs(value)).toBeLessThan(1e-15);
    // classical result for a quasi-isotropic laminate: alpha = (alpha1 + alpha2) / 2 + nu-coupling terms; it lies between the lamina values
    expect(perKelvin?.strain[0]).toBeGreaterThan(-0.3e-6);
    expect(perKelvin?.strain[0]).toBeLessThan(28e-6);
  });

  it('curves an unsymmetric laminate and not a symmetric one', () => {
    const unsym = run('[0/90]T', { environment: { deltaT: -100 } });
    expect(Math.abs(unsym.environment.freeCurvature[0] ?? 0)).toBeGreaterThan(1e-6);
    expect(unsym.environment.freeCurvature[0]).toBeCloseTo(-(unsym.environment.freeCurvature[1] ?? NaN), 9);
    const sym = run('[0/90]s', { environment: { deltaT: -100 } });
    for (const value of sym.environment.freeCurvature) expect(Math.abs(value)).toBeLessThan(1e-12);
  });

  it('builds the cure-cooldown residual stresses of a cross-ply laminate in force balance', () => {
    const result = run('[0/90]s', { environment: { deltaT: -100 } });
    const zero = result.plies.filter((ply) => ply.angleDeg === 0);
    const ninety = result.plies.filter((ply) => ply.angleDeg === 90);
    expect(zero.every((ply) => (ply.top.stress12Mpa[0] ?? 0) < 0)).toBe(true);
    expect(ninety.every((ply) => (ply.top.stress12Mpa[1] ?? 0) > 0)).toBe(true);
    const thickness = 0.125;
    const sum = (component: number): number =>
      result.plies.reduce(
        (total, ply) => total + ((ply.top.stressXyMpa[component] ?? 0) + (ply.bottom.stressXyMpa[component] ?? 0)) * 0.5 * thickness,
        0,
      );
    expect(Math.abs(sum(0))).toBeLessThan(1e-6);
    expect(Math.abs(sum(1))).toBeLessThan(1e-6);
  });

  it('applies moisture swelling like thermal strain and reports the combined state', () => {
    const wet = run('[0_8]T', { environment: { deltaMoisture: 0.01 } });
    expect(wet.midplane.strain[1]).toBeCloseTo(0.3 * 0.01, 12);
    expect(wet.midplane.strain[0]).toBeCloseTo(0, 12);
  });

  it('lowers the strength ratio by the residual stresses and reports 0 when the state alone fails', () => {
    const plain = run('[0/90]s', { loads: { Nx: 1 } });
    const cooled = run('[0/90]s', { loads: { Nx: 1 }, environment: { deltaT: -100 } });
    expect(r(cooled.firstPlyFailure['max_stress']?.R)).toBeLessThan(r(plain.firstPlyFailure['max_stress']?.R));
    expect(r(cooled.firstPlyFailure['tsai_wu']?.R)).toBeLessThan(r(plain.firstPlyFailure['tsai_wu']?.R));
    const failed = run('[0/90]s', { loads: { Nx: 1 }, environment: { deltaT: -400 } });
    expect(failed.firstPlyFailure['max_stress']?.R).toBe(0);
    expect(failed.firstPlyFailure['max_stress']?.mode).toBe('environment');
    const stateOnly = run('[0/90]s', { environment: { deltaT: -100 } });
    expect(stateOnly.firstPlyFailure['max_stress']?.R).toBeNull();
  });

  it('refuses an environment without the expansion coefficients, and is pure', () => {
    expectRefusal(
      bare,
      'analyze_laminate',
      { laminate: '[0/90]s', material: 'plain', environment: { deltaT: 50 } },
      'CMP_MATERIAL_HYGROTHERMAL_MISSING',
    );
    expectRefusal(
      bare,
      'analyze_laminate',
      { laminate: '[0/90]s', material: 'plain', environment: { deltaMoisture: 0.01 } },
      'CMP_MATERIAL_HYGROTHERMAL_MISSING',
    );
    expect(
      execute(bare, 'analyze_laminate', { laminate: '[0/90]s', material: 'plain', environment: { deltaT: 0 } }).rejected,
    ).toBeUndefined();
    expectPure(doc, () => run('[0/90]s', { environment: { deltaT: 50 } }));
  });
});

describe('LaRC03 failure criterion (M6)', () => {
  const ratio = (loads: object, laminate = '[0_8]T'): { R: number; mode: string } => {
    const result = run(laminate, { loads, criteria: ['larc03'] });
    return result.firstPlyFailure['larc03'] as { R: number; mode: string };
  };

  it('reproduces the lamina strengths in the pure stress states (h = 1 mm)', () => {
    expect(ratio({ Nx: 1 }).R).toBeCloseTo(1500, 3);
    expect(ratio({ Nx: 1 }).mode).toBe('FT');
    expect(ratio({ Nx: -1 }).R).toBeCloseTo(1500, 3);
    expect(ratio({ Nx: -1 }).mode).toBe('FC');
    expect(ratio({ Ny: 1 }).R).toBeCloseTo(40, 4);
    expect(ratio({ Ny: 1 }).mode).toBe('MT');
    expect(ratio({ Ny: -1 }).R).toBeGreaterThan(245);
    expect(ratio({ Ny: -1 }).R).toBeLessThan(247);
    expect(ratio({ Ny: -1 }).mode).toBe('MC');
    expect(ratio({ Nxy: 1 }).R).toBeCloseTo(68, 4);
  });

  it('matches the laminate failure order of the other criteria on a quasi-isotropic stack under tension', () => {
    const qi = run('[0/45/-45/90]s', { loads: { Nx: 1 }, criteria: ['larc03', 'max_stress'] });
    const larc = qi.firstPlyFailure['larc03'];
    expect(larc?.R).toBeGreaterThan(100);
    expect(larc?.R).toBeLessThan(400);
    expect(['MT', 'FC']).toContain(larc?.mode);
  });

  it('refuses a material without toughness values and an unloaded state has no ratio', () => {
    expectRefusal(
      bare,
      'analyze_laminate',
      { laminate: '[0/90]s', material: 'plain', loads: { Nx: 1 }, criteria: ['larc03'] },
      'CMP_MATERIAL_ALLOWABLE_MISSING',
    );
    expect(run('[0_8]T', { loads: { Nx: 0 }, criteria: ['larc03'] }).firstPlyFailure['larc03']?.R).toBeNull();
  });

  it('degrades compressive strength under transverse tension in the kinking branch', () => {
    const combined = run('[0_8]T', { loads: { Nx: -1, Ny: 0.05 }, criteria: ['larc03'] }).firstPlyFailure['larc03'];
    expect(r(combined?.R)).toBeGreaterThan(0);
    expect(r(combined?.R)).toBeLessThan(1500);
    const shear = run('[0_8]T', { loads: { Nx: -1, Nxy: 0.1 }, criteria: ['larc03'] }).firstPlyFailure['larc03'];
    expect(r(shear?.R)).toBeLessThan(1500);
  });
});

describe('material fields', () => {
  it('stores the hygrothermal and toughness data and rejects non-positive toughness', () => {
    expect(doc.composites?.materials['HT']).toMatchObject({ alpha1: -0.3e-6, beta2: 0.3, GIc: 0.2, GIIc: 0.8 });
    expectRefusal(withMaterials(), 'create_lamina_material', { ...T300, name: 'bad', GIc: 0 }, 'CMP_MATERIAL_NOT_POSITIVE');
  });
});
