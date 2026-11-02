/**
 * VC-EQP-09: empty / operating / test weights of `equipment_weights` for SC-EQP-01 and SC-EQP-02 (expected_results.json, derived from the exact
 * offset-solid heads by derive_expected.py) and the legs case, plus the nozzle option and the single source of truth with the legacy `weight`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { drumDocument, drumParams, mmDocument, separatorDocument, separatorParams } from './equipmentFixtures';

const VALIDATION = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation');
const expectedWeights = (
  JSON.parse(readFileSync(path.join(VALIDATION, 'expected_results.json'), 'utf8')) as {
    cases: Array<{ id: string; expected: Record<string, Record<string, number | string>> }>;
  }
).cases.find((candidate) => candidate.id === 'VC-EQP-09')?.expected as Record<string, Record<string, number | string>>;

interface Weights {
  body: { emptyKg: number; operatingKg: number; testKg: number };
  nozzles?: { kg: number };
  total: { emptyKg: number; operatingKg: number; testKg: number };
  breakdown: Array<{ part: string; kg: number; method: string }>;
  defaulted: string[];
  warnings: Array<{ code: string; paths: string[] }>;
  unverified: boolean;
  operatingLiquidM3: number | null;
}

const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
const weights = (doc: ReturnType<typeof mmDocument>, equipment: string, include?: string[]): Weights =>
  data<Weights>(doc, 'equipment_weights', include === undefined ? { equipment } : { equipment, include });

describe('VC-EQP-09: SC-EQP-01 vertical separator (rho 7850 given, 1e-6 relative)', () => {
  const result = weights(separatorDocument(), 'V-101', ['body']);
  const expected = expectedWeights['SC-EQP-01'] as Record<string, number>;

  it('empty, operating and test weights', () => {
    expect(rel(result.body.emptyKg, expected.emptyKg as number)).toBeLessThan(1e-6);
    expect(rel(result.body.operatingKg, expected.operatingKg as number)).toBeLessThan(1e-6);
    expect(rel(result.body.testKg, expected.testKg as number)).toBeLessThan(1e-6);
  });

  it('breakdown: shell, two exact head solids (194.637 kg each, not the thin-wall 191.459) and the skirt 754.642 kg', () => {
    const kg = Object.fromEntries(result.breakdown.map((part) => [part.part, part.kg]));
    expect(Object.keys(kg)).toEqual(['shell', 'headBottom', 'headTop', 'skirt']);
    expect(rel(kg.headTop as number, 194.637)).toBeLessThan(1e-5);
    expect(rel(kg.skirt as number, 754.642)).toBeLessThan(1e-6);
    expect(result.breakdown.reduce((sum, part) => sum + part.kg, 0)).toBeCloseTo(result.body.emptyKg, 9);
    expect(result.total).toEqual(result.body);
    expect(result.nozzles).toBeUndefined();
  });

  it('is the number the legacy weight field carries (one source of truth)', () => {
    const element = Object.values(separatorDocument().building?.elements ?? {}).find(
      (candidate): candidate is EquipmentElement => candidate.category === 'equipment',
    ) as EquipmentElement;
    expect(element.weight).toBe(result.body.operatingKg);
  });

  it('the density default is named when design.materialDensityKgM3 is absent', () => {
    expect(result.defaulted.join()).not.toContain('7850');
    const { materialDensityKgM3: _ignored, ...design } = separatorParams.design;
    const doc = apply(mmDocument(), 'add_vessel', { ...separatorParams, design });
    const defaulted = weights(doc, 'V-101');
    expect(defaulted.defaulted.some((line) => line.includes('7850 kg/m3 (steel, named default)'))).toBe(true);
    expect(defaulted.body.emptyKg).toBe(result.body.emptyKg);
  });
});

describe('VC-EQP-09: SC-EQP-02 horizontal drum on saddles', () => {
  const result = weights(drumDocument(), 'D-201', ['body']);
  const expected = expectedWeights['SC-EQP-02'] as Record<string, number>;

  it('empty and test weights (no operating liquid: operating = empty, with a coded warning)', () => {
    expect(rel(result.body.emptyKg, expected.emptyKg as number)).toBeLessThan(1e-6);
    expect(rel(result.body.testKg, expected.testKg as number)).toBeLessThan(1e-6);
    expect(result.body.operatingKg).toBe(result.body.emptyKg);
    expect(result.warnings).toEqual([{ code: 'EQP_DESIGN_DATA_MISSING', message: expect.any(String), paths: ['design.operatingLiquid'] }]);
    expect(result.breakdown.map((part) => part.part)).toEqual(['shell', 'headLeft', 'headRight']);
  });

  it('a horizontal vessel with a torispherical head at a partial level has no closed form: operating = empty, EQP_HEAD_NOT_COVERED warning', () => {
    const torispherical = { type: 'torispherical', standard: 'asme_fd' };
    const doc = apply(mmDocument(), 'add_vessel', {
      ...drumParams,
      heads: { left: torispherical, right: torispherical },
      design: { ...drumParams.design, operatingLiquid: { specificGravity: 1, levelAboveBottomTangent: 500 } },
    });
    const partial = weights(doc, 'D-201');
    expect(partial.operatingLiquidM3).toBeNull();
    expect(partial.warnings.map((warning) => warning.code)).toEqual(['EQP_HEAD_NOT_COVERED']);
    expect(partial.body.operatingKg).toBe(partial.body.emptyKg);
  });
});

describe('VC-EQP-09: legs case', () => {
  it('4 legs, height 1500 mm, section 10 000 mm2 (100 mm square), rho 7850 -> 471.0 kg', () => {
    const doc = apply(mmDocument(), 'add_vessel', { ...separatorParams, support: { type: 'legs', count: 4, height: 1500, legWidth: 100 } });
    const legs = weights(doc, 'V-101').breakdown.find((part) => part.part === 'legs');
    expect(rel(legs?.kg ?? 0, (expectedWeights.legsCase as Record<string, number>).legsKg as number)).toBeLessThan(1e-12);
  });
});

describe('equipment_weights: nozzles option, refusals', () => {
  const doc = separatorDocument();

  it('include nozzles adds one neck + flange part per nozzle to total, never to body; a placeholder flange is listed in defaulted', () => {
    const result = weights(doc, 'V-101', ['body', 'nozzles']);
    const nozzles = result.breakdown.filter((part) => part.part.startsWith('nozzle '));
    expect(nozzles.map((part) => part.part)).toEqual(['nozzle N1', 'nozzle N2', 'nozzle N3', 'nozzle M1']);
    expect(result.nozzles?.kg).toBeCloseTo(
      nozzles.reduce((sum, part) => sum + part.kg, 0),
      9,
    );
    expect(result.total.emptyKg).toBeCloseTo(result.body.emptyKg + (result.nozzles?.kg ?? 0), 9);
    expect(result.body.emptyKg).toBe(weights(doc, 'V-101').body.emptyKg);
    expect(result.defaulted.some((line) => line.startsWith('nozzle M1'))).toBe(true);
    expect(result.unverified).toBe(true);
    const sizes = nozzles.map((part) => part.kg);
    expect(sizes[3]).toBeGreaterThan((sizes[0] as number) * 5);
  });

  it('is read-only, deterministic, and refuses unknown, legacy and unsupported requests', () => {
    const result = execute(doc, 'equipment_weights', { equipment: 'V-101' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(JSON.stringify(execute(doc, 'equipment_weights', { equipment: 'V-101' }).data)).toBe(JSON.stringify(result.data));
    expectRefusal(doc, 'equipment_weights', { equipment: 'V-404' }, 'EQP_NOT_FOUND', 'equipment');
    const legacy = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    expectRefusal(legacy, 'equipment_weights', { equipment: 'S-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
    expect(execute(doc, 'equipment_weights', { equipment: 'V-101', include: ['insulation'] }).rejected).toBe(true);
  });
});
