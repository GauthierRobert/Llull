/**
 * Plant 03 EQP-FU: equipment_cog, insulation and internals weights, head centroids. Oracles are closed forms re-derived in the tests:
 * the centroid of a hemispherical shell solid 3/8 (Ro^4 - Ri^4) / (Ro^3 - Ri^3) from the base plane, of a half-ellipsoid cavity 3a/8, and the
 * moment balance sum(m z) / sum(m) of the mass lines that equipment_weights reports.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { headFillCentroid, headMetalCentroid } from '@aec/plant/equipment/geometry/headCentroid';
import type { HeadShape } from '@aec/plant/equipment/geometry/heads';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemDocument, mmDocument } from './equipmentFixtures';

const hemisphere = (radius: number): HeadShape => ({ kind: 'spherical', depth: radius });

describe('head centroids', () => {
  it('hemispherical shell R 1000, t 10: 3/8 (1010^4 - 1000^4) / (1010^3 - 1000^3) = 502.5083 from the tangent plane', () => {
    const expected = (3 / 8) * ((1010 ** 4 - 1000 ** 4) / (1010 ** 3 - 1000 ** 3));
    expect(expected).toBeCloseTo(502.5083, 4);
    expect(headMetalCentroid(hemisphere(1000), 1000, 10)).toBeCloseTo(expected, 6);
  });

  it('the cavity of a half-ellipsoid (2:1, R 500, depth 250) and of a hemisphere (R 500) has its centroid at 3a/8 = 93.75 and 187.5', () => {
    expect(headFillCentroid({ kind: 'ellipsoidal', depth: 250 }, 500, 250).centroid).toBeCloseTo(93.75, 8);
    expect(headFillCentroid(hemisphere(500), 500, 500).centroid).toBeCloseTo(187.5, 8);
  });

  it('a partial fill: the slab of a hemisphere cavity up to h = 250 above the tangent plane holds pi (R^2 h - h^3 / 3) with its centroid inside the slab', () => {
    const half = headFillCentroid(hemisphere(500), 500, 250);
    expect(half.volume).toBeCloseTo(Math.PI * (500 ** 2 * 250 - 250 ** 3 / 3), 3);
    expect(half.volume).toBeLessThan(headFillCentroid(hemisphere(500), 500, 500).volume);
    expect(half.centroid).toBeGreaterThan(0);
    expect(half.centroid).toBeLessThan(250);
  });

  it('a conical head (45 degrees, R 500, t 10): the metal between two similar cones has its centroid at (1/4) (Ro^4 - Ri^4) / (Ro^3 - Ri^3), Ro = 500 + 10 / cos 45', () => {
    const outer = 500 + 10 / Math.cos(Math.PI / 4);
    const expected = (1 / 4) * ((outer ** 4 - 500 ** 4) / (outer ** 3 - 500 ** 3));
    expect(headMetalCentroid({ kind: 'conical', depth: 500 }, 500, 10)).toBeCloseTo(expected, 8);
  });

  it('a torispherical head (ASME F&D, D 1000): the metal centroid lies between the tangent plane and the apex; so does the cavity centroid (below the 3/8 of a hemisphere)', () => {
    const alpha = Math.asin((500 - 60) / (1000 - 60));
    const shape: HeadShape = {
      kind: 'torispherical',
      depth: 1000 * (1 - Math.cos(alpha)) + 60 * Math.cos(alpha),
      crownRadius: 1000,
      knuckleRadius: 60,
      alpha,
      crownDepth: 1000 * (1 - Math.cos(alpha)),
      knuckleDepth: 60 * Math.cos(alpha),
    };
    const metal = headMetalCentroid(shape, 500, 10);
    expect(metal).toBeGreaterThan(0);
    expect(metal).toBeLessThan(shape.depth + 10);
    const cavity = headFillCentroid(shape, 500, shape.depth).centroid;
    expect(cavity).toBeGreaterThan(0);
    expect(cavity).toBeLessThan(shape.depth / 2);
  });

  it('a head without metal (t = 0) has no centroid: 0, for every head kind', () => {
    for (const shape of [hemisphere(500), { kind: 'ellipsoidal', depth: 250 } as HeadShape, { kind: 'conical', depth: 500 } as HeadShape])
      expect(headMetalCentroid(shape, 500, 0)).toBe(0);
  });

  it('a flat head is a plate of thickness t beyond the tangent plane (t / 2) and holds no liquid', () => {
    expect(headMetalCentroid({ kind: 'flat', depth: 0 }, 500, 12)).toBe(6);
    expect(headFillCentroid({ kind: 'flat', depth: 0 }, 500, 0)).toEqual({ volume: 0, centroid: 0 });
  });
});

const hemi = { type: 'hemispherical' };
const params = (extra: object = {}, design: object = {}): object => ({
  tag: 'V-1',
  orientation: 'vertical',
  location: [1000, 2000],
  insideDiameter: 1000,
  tangentLength: 2000,
  heads: { top: hemi, bottom: hemi },
  shellThickness: 10,
  headThickness: 10,
  corrosionAllowance: 0,
  support: { type: 'none' },
  design: { materialDensityKgM3: 7850, ...design },
  ...extra,
});
const vessel = (extra: object = {}, design: object = {}): CadDocument => apply(mmDocument(), 'add_vessel', params(extra, design));

interface Cog {
  empty: { kg: number; local: number[]; world: number[]; heightAboveLevel: number };
  operating: { kg: number; local: number[] } | null;
  test: { kg: number; local: number[] };
  parts: Array<{ part: string; kg: number; local: number[] }>;
  defaulted: string[];
  warnings: Array<{ code: string }>;
}
interface Weights {
  body: { emptyKg: number; operatingKg: number; testKg: number };
  total: { emptyKg: number; operatingKg: number; testKg: number };
  breakdown: Array<{ part: string; kg: number }>;
  operatingLiquidM3: number;
}
const cog = (doc: CadDocument, extra: object = {}): Cog => data<Cog>(doc, 'equipment_cog', { equipment: 'V-1', ...extra });
const weights = (doc: CadDocument, extra: object = {}): Weights => data<Weights>(doc, 'equipment_weights', { equipment: 'V-1', ...extra });
const massOf = (list: Weights, part: string): number => (list.breakdown.find((line) => line.part === part) as { kg: number }).kg;

describe('equipment_cog: vertical vessels', () => {
  it('symmetric heads, no support, no liquid: the centre is on the axis at mid tangent length, in the equipment frame and in world (location + level)', () => {
    const result = cog(vessel());
    expect(result.empty.local[0]).toBeCloseTo(0, 9);
    expect(result.empty.local[1]).toBeCloseTo(0, 9);
    expect(result.empty.local[2]).toBeCloseTo(1000, 7);
    expect(result.empty.heightAboveLevel).toBeCloseTo(1000, 7);
    expect(result.empty.world[0]).toBeCloseTo(1000, 7);
    expect(result.empty.world[1]).toBeCloseTo(2000, 7);
    expect(result.empty.kg).toBeCloseTo(weights(vessel()).body.emptyKg, 9);
    expect(result.operating).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(['EQP_DESIGN_DATA_MISSING']);
  });

  it('with a skirt the centre follows the moment balance of the mass lines: shell L/2, heads at the offset-shell centroid, skirt and base ring', () => {
    const doc = vessel({ support: { type: 'skirt', height: 800, thickness: 8, baseRingWidth: 50 } });
    const list = weights(doc);
    const c = (3 / 8) * ((510 ** 4 - 500 ** 4) / (510 ** 3 - 500 ** 3));
    const lines: Array<[number, number]> = [
      [massOf(list, 'shell'), 800 + 1000],
      [massOf(list, 'headBottom'), 800 - c],
      [massOf(list, 'headTop'), 800 + 2000 + c],
      [massOf(list, 'skirt'), 400],
      [massOf(list, 'baseRing'), 4],
    ];
    const kg = lines.reduce((sum, [mass]) => sum + mass, 0);
    const z = lines.reduce((sum, [mass, height]) => sum + mass * height, 0) / kg;
    const result = cog(doc);
    expect(kg).toBeCloseTo(list.body.emptyKg, 9);
    expect(result.empty.local[2]).toBeCloseTo(z, 7);
    expect(result.empty.kg).toBeCloseTo(kg, 9);
  });

  it('insulation (50 mm, 100 kg/m3) adds the shell annulus and two hemispherical layers: V = pi (560^2 - 510^2) 2000 + 2 x 2/3 pi (560^3 - 510^3) mm3, centre unchanged', () => {
    const base = vessel();
    const insulated = vessel({}, { insulation: { thickness: 50, densityKgM3: 100 } });
    const volume = Math.PI * (560 ** 2 - 510 ** 2) * 2000 + 2 * (2 / 3) * Math.PI * (560 ** 3 - 510 ** 3);
    const expected = volume * 1e-9 * 100;
    expect(expected).toBeCloseTo(51.6118, 3);
    const list = weights(insulated);
    const layers = list.breakdown.filter((line) => line.part.startsWith('insulation'));
    expect(layers.map((line) => line.part)).toEqual(['insulation shell', 'insulation headBottom', 'insulation headTop']);
    expect(layers.reduce((sum, line) => sum + line.kg, 0)).toBeCloseTo(expected, 6);
    expect(list.body.emptyKg - weights(base).body.emptyKg).toBeCloseTo(expected, 6);
    expect(list.total.testKg - weights(base).total.testKg).toBeCloseTo(expected, 6);
    expect(cog(insulated).empty.local[2]).toBeCloseTo(1000, 6);
  });

  it('internals are lumped masses: 1000 kg at 500 above the bottom tangent line moves the centre to (m0 x 1000 + 1000 x 500) / (m0 + 1000); without a position they sit at mid-shell and are listed as defaulted', () => {
    const doc = vessel({}, { internals: [{ label: 'trays 1-10', kg: 1000, position: 500 }] });
    const m0 = weights(vessel()).body.emptyKg;
    expect(weights(doc).body.emptyKg).toBeCloseTo(m0 + 1000, 9);
    expect(massOf(weights(doc), 'internals: trays 1-10')).toBe(1000);
    const result = cog(doc);
    expect(result.empty.local[2]).toBeCloseTo((m0 * 1000 + 1000 * 500) / (m0 + 1000), 7);
    const unplaced = cog(vessel({}, { internals: [{ label: 'demister', kg: 80 }] }));
    expect(unplaced.empty.local[2]).toBeCloseTo(1000, 7);
    expect(unplaced.defaulted).toEqual(['internals: demister: position = middle of the shell']);
  });

  it('operating liquid up to the top tangent line: hemispherical bottom cavity 2/3 pi R^3 at -3R/8 and the shell column at L/2 shift the centre down', () => {
    const doc = vessel({}, { operatingLiquid: { specificGravity: 0.8, levelAboveBottomTangent: 2000 } });
    const list = weights(doc);
    const empty = list.body.emptyKg;
    const hemisphereKg = (2 / 3) * Math.PI * 500 ** 3 * 1e-9 * 800;
    const columnKg = Math.PI * 500 ** 2 * 2000 * 1e-9 * 800;
    const result = cog(doc);
    expect(result.operating?.kg).toBeCloseTo(list.body.operatingKg, 8);
    expect(result.operating?.kg).toBeCloseTo(empty + hemisphereKg + columnKg, 8);
    const z = (empty * 1000 + hemisphereKg * (-(3 * 500) / 8) + columnKg * 1000) / (empty + hemisphereKg + columnKg);
    expect(result.operating?.local[2]).toBeCloseTo(z, 6);
    expect(result.test.kg).toBeCloseTo(list.body.testKg, 8);
    expect(result.test.local[2]).toBeCloseTo(1000, 6);
  });

  it('nozzles are added on request: the empty mass equals equipment_weights total with include nozzles and the centre moves toward the nozzle side', () => {
    const doc = apply(vessel(), 'add_nozzle', {
      equipment: 'V-1',
      mark: 'N1',
      dn: 200,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'shell', elevation: 1500, orientationDeg: 90 },
      projection: 800,
    });
    const without = cog(doc);
    const included = cog(doc, { include: ['body', 'nozzles'] });
    expect(included.empty.kg).toBeCloseTo(weights(doc, { include: ['body', 'nozzles'] }).total.emptyKg, 9);
    expect(included.empty.kg).toBeGreaterThan(without.empty.kg);
    expect(Math.abs(included.empty.local[0] as number) + Math.abs(included.empty.local[1] as number)).toBeGreaterThan(1e-3);
    expect(included.parts.map((part) => part.part)).toContain('nozzle N1');
    expect(without.parts.map((part) => part.part)).not.toContain('nozzle N1');
  });
});

describe('equipment_cog: horizontal vessels', () => {
  const horizontal = (design: object = {}, heads: object = { left: hemi, right: hemi }): CadDocument =>
    vessel(
      { orientation: 'horizontal', heads, support: { type: 'saddles', stations: [500, 1500], width: 200, axisElevation: 900 } },
      design,
    );

  it('a full vessel of symmetric heads has its centre on the axis, at the middle: z = axis elevation, x = 0, and the operating mass equals equipment_weights', () => {
    const doc = horizontal({ operatingLiquid: { specificGravity: 1, levelAboveBottomTangent: 1000 } });
    const result = cog(doc);
    const list = weights(doc);
    expect(result.empty.local[0]).toBeCloseTo(0, 7);
    expect(result.empty.local[2]).toBeCloseTo(900, 7);
    expect(result.operating?.kg).toBeCloseTo(list.body.operatingKg, 8);
    expect(result.operating?.local[0]).toBeCloseTo(0, 7);
    expect(result.operating?.local[2]).toBeCloseTo(900, 6);
  });

  it('a half-full shell puts the liquid centroid 4R / (3 pi) = 212.2 mm below the axis; the operating centre lies between the empty centre and that', () => {
    const doc = horizontal({ operatingLiquid: { specificGravity: 1, levelAboveBottomTangent: 500 } });
    const result = cog(doc);
    expect(result.operating?.kg).toBeCloseTo(weights(doc).body.operatingKg, 7);
    const shellLiquid = (Math.PI * 500 ** 2 * 2000 * 1e-9) / 2;
    const heads = weights(doc).operatingLiquidM3 - shellLiquid * 1;
    expect(heads).toBeGreaterThan(0);
    const z = result.operating?.local[2] as number;
    expect(z).toBeLessThan(900);
    expect(z).toBeGreaterThan(900 - (4 * 500) / (3 * Math.PI));
  });

  it('an asymmetric pair of heads (hemisphere left, 2:1 right) moves the empty centre along X toward the heavier head', () => {
    const doc = horizontal({}, { left: hemi, right: { type: 'ellipsoidal', ratio: 2 } });
    expect(cog(doc).empty.local[0]).toBeLessThan(0);
  });

  it('a torispherical head at a partial level has no closed-form liquid: operating is null with EQP_HEAD_NOT_COVERED, the empty and test states still answer', () => {
    const doc = horizontal(
      { operatingLiquid: { specificGravity: 1, levelAboveBottomTangent: 400 } },
      { left: { type: 'torispherical', standard: 'asme_fd' }, right: { type: 'torispherical', standard: 'asme_fd' } },
    );
    const result = cog(doc);
    expect(result.operating).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(['EQP_HEAD_NOT_COVERED']);
    expect(result.test.kg).toBeGreaterThan(result.empty.kg);
  });
});

describe('equipment_cog: refusals and purity', () => {
  it('refuses an unknown equipment and a non-vessel, leaving the document unchanged', () => {
    expectRefusal(vessel(), 'equipment_cog', { equipment: 'V-9' }, 'EQP_NOT_FOUND', 'equipment');
    expectRefusal(bemDocument(false), 'equipment_cog', { equipment: 'E-301' }, 'EQP_NOT_PARAMETRIC', 'equipment');
  });

  it('is a query: the document is returned unchanged', () => {
    const doc = vessel();
    const result = execute(doc, 'equipment_cog', { equipment: 'V-1' });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('an insulation or internals value that is not positive is a schema error, never a default', () => {
    for (const design of [
      { insulation: { thickness: 50 } },
      { insulation: { thickness: -1, densityKgM3: 100 } },
      { internals: [{ label: 'x', kg: 0 }] },
    ]) {
      const result = execute(mmDocument(), 'add_vessel', params({}, design));
      expect(result.error?.code, JSON.stringify(design)).toBe('CMD_INVALID_PARAMS');
    }
  });
});
