/**
 * Plant 03 EQP-FU2: equipment_cog for exchangers, tanks and pumps. Oracles are re-derived here: the moment balance sum(m z) / sum(m) of the mass lines
 * of equipment_weights at independently written heights, symmetry (a BEM exchanger is mirror-symmetric about its middle), Archimedes for the dome roof,
 * and the water volume of vessel_volume.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemDocument, bemParams, mmDocument, pumpDocument, tankDocument, tankParams } from './equipmentFixtures';

interface Cog {
  empty: { kg: number; local: number[]; world: number[] };
  operating: { kg: number; local: number[] } | null;
  test: { kg: number; local: number[] };
  parts: Array<{ part: string; kg: number; local: number[] }>;
  liquidParts: Array<{ part: string; kg: number; local: number[] }>;
  defaulted: string[];
  approximations: string[];
  warnings: Array<{ code: string }>;
}
interface Weights {
  body: { emptyKg: number; operatingKg: number; testKg: number };
  total: { emptyKg: number };
  breakdown: Array<{ part: string; kg: number }>;
}
const cog = (doc: CadDocument, equipment: string, extra: object = {}): Cog => data<Cog>(doc, 'equipment_cog', { equipment, ...extra });
const weights = (doc: CadDocument, equipment: string, extra: object = {}): Weights =>
  data<Weights>(doc, 'equipment_weights', { equipment, ...extra });
const mass = (list: Weights, part: string): number => (list.breakdown.find((line) => line.part === part) as { kg: number }).kg;
const balance = (lines: Array<[number, number]>): { kg: number; at: number } => {
  const kg = lines.reduce((sum, [m]) => sum + m, 0);
  return { kg, at: lines.reduce((sum, [m, z]) => sum + m * z, 0) / kg };
};

describe('equipment_cog: tanks', () => {
  const thick = { ...tankParams, courseThicknesses: [10, 10, 10, 10, 10, 10], roof: { type: 'cone', slopeRatio: 0.1, thickness: 5 } };
  const doc = apply(mmDocument(), 'add_storage_tank', thick);

  it('empty: courses at mid-height above the 6 mm bottom plate, bottom at 3, cone roof at one third of its rise above the shell top (moment balance)', () => {
    const list = weights(doc, 'T-401');
    const rise = 0.1 * 10010;
    const lines: Array<[number, number]> = [
      ...[1, 2, 3, 4, 5, 6].map((index): [number, number] => [mass(list, `course ${index}`), 6 + 2000 * (index - 1) + 1000]),
      [mass(list, 'bottom'), 3],
      [mass(list, 'roof'), 6 + 12000 + rise / 3],
    ];
    const expected = balance(lines);
    const result = cog(doc, 'T-401');
    expect(expected.kg).toBeCloseTo(list.body.emptyKg, 8);
    expect(result.empty.kg).toBeCloseTo(expected.kg, 8);
    expect(result.empty.local[2]).toBeCloseTo(expected.at, 7);
    expect(result.empty.local[0]).toBeCloseTo(0, 9);
    expect(result.empty.local[1]).toBeCloseTo(0, 9);
    expect(result.empty.world.slice(0, 2)).toEqual([30000, 0]);
  });

  it('operating and test add the liquid column at mid-level: V = pi R^2 h (document units cubed), density 1000 SG', () => {
    const list = weights(doc, 'T-401');
    const empty = cog(doc, 'T-401').empty;
    const liquidKg = Math.PI * 10000 ** 2 * 12000 * 1e-9 * 1000;
    const result = cog(doc, 'T-401');
    expect(result.operating?.kg).toBeCloseTo(empty.kg + liquidKg, 6);
    expect(result.operating?.kg).toBeCloseTo(list.body.operatingKg, 6);
    expect(result.operating?.local[2]).toBeCloseTo((empty.kg * empty.local[2]! + liquidKg * (6 + 6000)) / (empty.kg + liquidKg), 6);
    expect(result.test.kg).toBeCloseTo(list.body.testKg, 6);
    expect(result.liquidParts.map((part) => part.part)).toEqual(['liquid design level']);
  });

  it('a half-full tank puts the operating liquid at 6 + 3000; a dome roof centroid is half its rise (Archimedes), a flat roof sits at t / 2', () => {
    const half = apply(mmDocument(), 'add_storage_tank', { ...thick, design: { ...thick.design, designLiquidLevel: 6000 } });
    expect(cog(half, 'T-401').liquidParts[0]?.local[2]).toBeCloseTo(6 + 3000, 9);
    const dome = apply(mmDocument(), 'add_storage_tank', { ...thick, roof: { type: 'dome', radius: 16000, thickness: 5 } });
    const rise = 16000 - Math.sqrt(16000 ** 2 - 10010 ** 2);
    expect(cog(dome, 'T-401').parts.find((part) => part.part === 'roof')?.local[2]).toBeCloseTo(6 + 12000 + rise / 2, 6);
    const flat = apply(mmDocument(), 'add_storage_tank', { ...thick, roof: { type: 'flat', thickness: 5 } });
    expect(cog(flat, 'T-401').parts.find((part) => part.part === 'roof')?.local[2]).toBeCloseTo(6 + 12000 + 2.5, 9);
  });

  it('with include nozzles the nozzle lumps join the empty state and move the centre', () => {
    const withNozzle = apply(doc, 'add_nozzle', {
      equipment: 'T-401',
      mark: 'N1',
      dn: 200,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'shell', elevation: 500, orientationDeg: 90 },
      projection: 10500,
    });
    const body = cog(withNozzle, 'T-401');
    const full = cog(withNozzle, 'T-401', { include: ['nozzles'] });
    const nozzleKg = weights(withNozzle, 'T-401', { include: ['nozzles'] }).breakdown.find((line) => line.part === 'nozzle N1')?.kg ?? 0;
    expect(nozzleKg).toBeGreaterThan(0);
    expect(full.empty.kg).toBeCloseTo(body.empty.kg + nozzleKg, 8);
    expect(full.parts.find((part) => part.part === 'nozzle N1')?.local[0]).toBeGreaterThan(10000);
    expect(full.empty.local[0]).toBeGreaterThan(0);
  });
});

describe('equipment_cog: exchangers', () => {
  it('a BEM exchanger is symmetric about its middle: x = 0 in every state, z = the tube axis (saddle axis elevation 1000)', () => {
    const result = cog(bemDocument(false), 'E-301');
    for (const state of [result.empty, result.test]) {
      expect(state.local[0]).toBeCloseTo(0, 8);
      expect(state.local[1]).toBeCloseTo(0, 9);
      expect(state.local[2]).toBeCloseTo(1000, 9);
    }
    expect(result.empty.kg).toBeCloseTo(weights(bemDocument(false), 'E-301').body.emptyKg, 8);
    expect(result.operating?.kg).toBeCloseTo(result.empty.kg, 9);
  });

  it('test = empty + the water of both sides: 1000 kg/m3 x (shell side + tube side) from vessel_volume', () => {
    const doc = bemDocument(false);
    const shell = data<{ totalVolumeM3: number }>(doc, 'vessel_volume', { equipment: 'E-301', side: 'shell' }).totalVolumeM3;
    const tube = data<{ totalVolumeM3: number }>(doc, 'vessel_volume', { equipment: 'E-301', side: 'tube' }).totalVolumeM3;
    const result = cog(doc, 'E-301');
    expect(result.test.kg - result.empty.kg).toBeCloseTo((shell + tube) * 1000, 6);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['EQP_DESIGN_DATA_MISSING', 'EQP_DESIGN_DATA_MISSING']);
  });

  it('operating adds only the sides that have a specific gravity: shell side 0.85 on a BEM (x = 0), kg = weights operatingKg', () => {
    const doc = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      design: { ...bemParams.design, shellSide: { ...bemParams.design.shellSide, specificGravity: 0.85 } },
    });
    const result = cog(doc, 'E-301');
    expect(result.operating?.kg).toBeCloseTo(weights(doc, 'E-301').body.operatingKg, 6);
    expect(result.operating?.local[0]).toBeCloseTo(0, 8);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['EQP_DESIGN_DATA_MISSING']);
    expect(result.liquidParts.every((part) => part.part.includes('shell side'))).toBe(true);
  });

  it('a BEU exchanger (U-tube, shell cover) is not symmetric: the centre follows the moment balance of the metal lumps at independent x positions', () => {
    const doc = apply(mmDocument(), 'add_heat_exchanger', { ...bemParams, temaType: 'BEU', rearChannel: undefined });
    const list = weights(doc, 'E-301');
    const result = cog(doc, 'E-301');
    const lines = result.parts.map((part): [number, number] => [part.kg, part.local[0] as number]);
    expect(balance(lines).kg).toBeCloseTo(list.body.emptyKg, 8);
    expect(result.empty.local[0]).toBeCloseTo(balance(lines).at, 9);
    // hand layout (shell front edge at 0): tubesheet [-50, 0] centre -25, channel [-350, -50] centre -200, shell [0, 4827] centre 2413.5,
    // tubes from the outer tubesheet face (-50) over 4877 mm, centre 2388.5; distances are independent of the recentring shift
    const byName = (name: string): number => result.parts.find((part) => part.part === name)?.local[0] as number;
    expect(byName('tubes') - byName('frontTubesheet')).toBeCloseTo(2388.5 + 25, 9);
    expect(byName('shell') - byName('frontTubesheet')).toBeCloseTo(2413.5 + 25, 9);
    expect(byName('frontChannel') - byName('frontTubesheet')).toBeCloseTo(-200 + 25, 9);
    expect(result.parts.some((part) => part.part === 'rearTubesheet')).toBe(false);
  });

  it('the exchanger nozzles join with include nozzles', () => {
    const doc = bemDocument(true);
    const body = cog(doc, 'E-301');
    const full = cog(doc, 'E-301', { include: ['nozzles'] });
    expect(full.parts.filter((part) => part.part.startsWith('nozzle '))).toHaveLength(4);
    expect(full.empty.kg).toBeGreaterThan(body.empty.kg);
  });
});

describe('equipment_cog: pumps', () => {
  const custom = {
    tag: 'P-9',
    location: [0, 0],
    standard: 'custom',
    rating: 'CL300',
    envelope: { a: 400, f: 300, h1: 200, h2: 300, suctionDn: 100, dischargeDn: 80, source: 'datasheet' },
    baseplate: { length: 1700, width: 500, height: 150 },
    driver: { length: 600, width: 400, height: 400, couplingGap: 100 },
    weightKg: 500,
  };

  it('the vendor weight sits at the centre of the pump + driver boxes: x -400..1000 recentred to 0, z 150..550 -> 350 (hand layout)', () => {
    const result = cog(apply(mmDocument(), 'add_pump', custom), 'P-9');
    expect(result.empty.kg).toBe(500);
    expect(result.empty.local[0]).toBeCloseTo(0, 9);
    expect(result.empty.local[1]).toBeCloseTo(0, 9);
    expect(result.empty.local[2]).toBeCloseTo(350, 9);
    expect(result.defaulted[0]).toContain('bounding box');
    expect(result.operating?.kg).toBe(500);
  });

  it('the ISO pump of the fixtures reports 310 kg and a position inside its bounding box', () => {
    const result = cog(pumpDocument(), 'P-101');
    expect(result.empty.kg).toBe(310);
    expect(result.empty.local[2]).toBeGreaterThan(0);
  });

  it('a pump without weightKg is refused EQP_DESIGN_DATA_MISSING at weightKg', () => {
    const { weightKg: _weight, ...bare } = custom;
    expectRefusal(apply(mmDocument(), 'add_pump', bare), 'equipment_cog', { equipment: 'P-9' }, 'EQP_DESIGN_DATA_MISSING', 'weightKg');
  });
});

describe('equipment_cog: refusals and purity (exchanger / tank / pump)', () => {
  it('a legacy block is EQP_NOT_PARAMETRIC and an unknown tag EQP_NOT_FOUND, both leaving the document unchanged', () => {
    const block = apply(mmDocument(), 'add_equipment', { name: 'Skid', mark: 'S-1', location: [0, 0], size: [1000, 1000, 1000] });
    expectRefusal(block, 'equipment_cog', { equipment: 'S-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
    expectRefusal(tankDocument(), 'equipment_cog', { equipment: 'T-9' }, 'EQP_NOT_FOUND', 'equipment');
  });

  it('is pure: the document is returned unchanged for each kind', () => {
    for (const [doc, tag] of [
      [tankDocument(), 'T-401'],
      [bemDocument(), 'E-301'],
      [pumpDocument(), 'P-101'],
    ] as const) {
      const before = JSON.stringify(doc);
      const result = execute(doc, 'equipment_cog', { equipment: tag, include: ['body', 'nozzles'] });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
});
