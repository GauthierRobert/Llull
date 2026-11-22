/**
 * Plant 03 EQP §13.10: bracket lugs on vertical vessels / exchangers and the kettle weir plate with the liquid volume to the weir. Oracles are closed
 * forms or numeric integrals written here; no number comes from running llull.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import type { BoxEntity, CadDocument, ExtrusionEntity } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemParams, mmDocument, separatorParams } from './equipmentFixtures';

const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const entityOf = <T>(doc: CadDocument, part: string): T => {
  const found = Object.entries(doc.entities).find(([id]) => id.endsWith(`:${part}`));
  if (found === undefined) throw new Error(`no entity ${part}`);
  return found[1] as T;
};
const partsOf = (doc: CadDocument): string[] => Object.keys(doc.entities).map((id) => id.split(':')[1] as string);
interface Weights {
  body: { emptyKg: number };
  breakdown: Array<{ part: string; kg: number }>;
}
const weightsOf = (doc: CadDocument, equipment: string): Weights => data<Weights>(doc, 'equipment_weights', { equipment });
interface Cog {
  parts: Array<{ part: string; kg: number; local: number[] }>;
}
const cogOf = (doc: CadDocument, equipment: string): Cog => data<Cog>(doc, 'equipment_cog', { equipment });
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

const STEEL = 7850e-9; // kg per mm3 (7850 kg/m3)
const lugs = {
  type: 'lugs',
  count: 4,
  lugHeight: 300,
  lugWidth: 200,
  lugProjection: 150,
  lugThickness: 20,
  lugBasePlateThickness: 25,
  lugBoltHoleDiameter: 30,
  lugElevation: 1000,
  baseElevation: 2000,
};
/** Metal volume of one lug by hand: web 20 x 150 x (300 - 25) + (200 x 150 - pi/4 x 30^2) x 25. */
const lugVolume = 20 * 150 * 275 + (200 * 150 - (Math.PI * 30 ** 2) / 4) * 25;
/** Height of its centroid above the bottom face. */
const lugCentre = (20 * 150 * 275 * (25 + 137.5) + (200 * 150 - (Math.PI * 30 ** 2) / 4) * 25 * 12.5) / lugVolume;

describe('lugs on a vertical vessel', () => {
  const doc = apply(mmDocument(), 'add_vessel', { ...separatorParams, support: lugs });

  it('derives a base plate and a web per lug at the lug azimuth, the first half a step off north', () => {
    expect(partsOf(doc).filter((part) => part.startsWith('lug-'))).toHaveLength(8);
    const base = entityOf<BoxEntity>(doc, 'lug-1-base');
    const web = entityOf<BoxEntity>(doc, 'lug-1-web');
    // shell outside radius 750 + 10; the lug projects 150: centre at radius 835, azimuth 45 deg
    const reach = 835 * Math.SQRT1_2;
    expect(base.size).toEqual([150, 200, 25]);
    expect(web.size).toEqual([150, 20, 275]);
    expect(base.position[0]).toBeCloseTo(5000 + reach, 2);
    expect(base.position[1]).toBeCloseTo(5000 + reach, 2);
    expect(base.position[2]).toBeCloseTo(2000 + 1000 + 12.5, 6);
    expect(web.position[2]).toBeCloseTo(3025 + 137.5, 6);
    expect(base.rotation[2]).toBeCloseTo(Math.PI / 4, 9);
  });

  it('adds count x lug volume x density to the empty weight and puts one lump at the lug centroid height on the axis', () => {
    const lugKg = weightsOf(doc, 'V-101').breakdown.find((part) => part.part === 'lugs')?.kg as number;
    expect(rel(lugKg, 4 * lugVolume * STEEL)).toBeLessThan(1e-12);
    const lump = cogOf(doc, 'V-101').parts.find((part) => part.part === 'lugs');
    expect(lump?.local[0]).toBeCloseTo(0, 9);
    expect(lump?.local[1]).toBeCloseTo(0, 9);
    expect(lump?.local[2]).toBeCloseTo(2000 + 1000 + lugCentre, 6);
  });

  it('the legacy size covers the outer corner of the base plate and the bottom tangent line is at baseElevation', () => {
    const [width, depth, top] = equipmentOf(doc, 'V-101').size;
    expect(width).toBeCloseTo(2 * Math.hypot(760 + 150, 100), 6);
    expect(depth).toBeCloseTo(width, 9);
    expect(top).toBeGreaterThan(2000 + 4000);
  });

  it('check_equipment states that no lug check is made, and does not state it without lugs', () => {
    expect(JSON.stringify(data(doc, 'check_equipment', {}))).toContain('lug structural checks');
    const plain = apply(mmDocument(), 'add_vessel', separatorParams);
    expect(JSON.stringify(data(plain, 'check_equipment', {}))).not.toContain('lug structural checks');
  });

  it('baseElevation is a named default and the document survives a save / load with the same derived solids', () => {
    const { baseElevation: _given, ...withoutBase } = lugs;
    const defaulted = apply(mmDocument(), 'add_vessel', { ...separatorParams, support: withoutBase });
    expect(equipmentOf(defaulted, 'V-101').plant?.template).toMatchObject({ support: { type: 'lugs', baseElevation: 0 } });
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(JSON.stringify(loaded.entities)).toBe(JSON.stringify(doc.entities));
  });

  it('is revised through update_equipment_parameters and a bad lug leaves the vessel as it was', () => {
    const plain = apply(mmDocument(), 'add_vessel', separatorParams);
    const revised = apply(plain, 'update_equipment_parameters', { equipment: 'V-101', set: { support: lugs } });
    expect(equipmentOf(revised, 'V-101').plant?.template).toMatchObject({ support: lugs });
    expect((equipmentOf(revised, 'V-101').plant?.template as { support: unknown }).support).toEqual(lugs);
    expectRefusal(
      plain,
      'update_equipment_parameters',
      { equipment: 'V-101', set: { support: { ...lugs, lugThickness: undefined } } },
      'EQP_SUPPORT_INVALID',
      'set.support.lugThickness',
    );
  });

  it.each([
    ['a missing dimension', { lugProjection: undefined }, 'support.lugProjection'],
    ['one lug', { count: 1 }, 'support.count'],
    ['more lugs than the named limit', { count: 25, lugWidth: 50 }, 'support.count'],
    ['a bolt hole that does not fit beside the web', { lugBoltHoleDiameter: 100 }, 'support.lugBoltHoleDiameter'],
    ['a web as wide as the base plate', { lugThickness: 200 }, 'support.lugThickness'],
    ['a lug above the shell', { lugElevation: 3900 }, 'support.lugElevation'],
    ['a base plate as thick as the lug', { lugBasePlateThickness: 300 }, 'support.lugBasePlateThickness'],
    ['a bolt hole wider than the base plate', { lugBoltHoleDiameter: 200 }, 'support.lugBoltHoleDiameter'],
    ['lugs wider than the circumference', { count: 24, lugWidth: 250 }, 'support.lugWidth'],
  ])('refuses %s by name and leaves the document unchanged', (_name, patch, path) => {
    expectRefusal(mmDocument(), 'add_vessel', { ...separatorParams, support: { ...lugs, ...patch } }, 'EQP_SUPPORT_INVALID', path);
  });

  it('refuses lugs on a horizontal vessel', () => {
    const ellipsoidal = { type: 'ellipsoidal', ratio: 2 };
    const horizontal = { ...separatorParams, orientation: 'horizontal', heads: { left: ellipsoidal, right: ellipsoidal } };
    expectRefusal(mmDocument(), 'add_vessel', { ...horizontal, support: lugs }, 'EQP_SUPPORT_INVALID', 'support.type');
  });

  it('is pure', () => {
    const input = mmDocument();
    const before = JSON.stringify(input);
    execute(input, 'add_vessel', { ...separatorParams, support: lugs });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('lugs on a vertical exchanger', () => {
  const exchanger = {
    ...bemParams,
    tag: 'E-401',
    orientation: 'vertical',
    support: { ...lugs, lugElevation: 400, lugBoltHoleDiameter: undefined },
  };
  const doc = apply(mmDocument(), 'add_heat_exchanger', exchanger);

  it('derives the lugs on the shell, weighs them and exports them to IFC without a warning', () => {
    expect(partsOf(doc).filter((part) => part.startsWith('lug-'))).toHaveLength(8);
    const plain = apply(mmDocument(), 'add_heat_exchanger', { ...exchanger, tag: 'E-402', support: { type: 'none', baseElevation: 2000 } });
    const noHole = 20 * 150 * 275 + 200 * 150 * 25;
    const extra = weightsOf(doc, 'E-401').body.emptyKg - weightsOf(plain, 'E-402').body.emptyKg;
    expect(rel(extra, 4 * noHole * STEEL)).toBeLessThan(1e-9);
    const ifc = data<{ ifc: string; warnings: unknown[] }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00' });
    expect(ifc.warnings).toEqual([]);
    expect(ifc.ifc.match(/IFCEXTRUDEDAREASOLID/g)?.length).toBeGreaterThanOrEqual(8);
    expect(data<{ rows: unknown[][] }>(doc, 'building_schedule', { kind: 'equipment' }).rows).toHaveLength(1);
  });

  it('lug elevation counts from the bottom tangent line: the lugs must lie on the shell (350..5127), not on the channel', () => {
    for (const lugElevation of [100, 4900])
      expectRefusal(
        mmDocument(),
        'add_heat_exchanger',
        { ...exchanger, support: { ...exchanger.support, lugElevation } },
        'EQP_SUPPORT_INVALID',
        'support.lugElevation',
      );
  });

  it('is revised through the exchanger patch and says that no lug check is made', () => {
    const horizontal = apply(mmDocument(), 'add_heat_exchanger', bemParams);
    const revised = apply(horizontal, 'update_equipment_parameters', {
      equipment: 'E-301',
      exchanger: { orientation: 'vertical', support: exchanger.support },
    });
    expect(equipmentOf(revised, 'E-301').plant?.template).toMatchObject({ orientation: 'vertical', support: { type: 'lugs' } });
    expect(JSON.stringify(data(revised, 'check_equipment', {}))).toContain('lug structural checks');
  });

  it('the revised support is exactly the lugs, and lugs can be replaced by legs without a trace of them', () => {
    const horizontal = apply(mmDocument(), 'add_heat_exchanger', bemParams);
    const lugged = apply(horizontal, 'update_equipment_parameters', {
      equipment: 'E-301',
      exchanger: { orientation: 'vertical', support: exchanger.support },
    });
    const support = (d: CadDocument): unknown => (equipmentOf(d, 'E-301').plant?.template as { support: unknown }).support;
    expect(support(lugged)).toEqual({ ...lugs, lugElevation: 400, lugBoltHoleDiameter: undefined });
    const legs = apply(lugged, 'update_equipment_parameters', {
      equipment: 'E-301',
      exchanger: { support: { type: 'legs', count: 4, height: 1000 } },
    });
    // pitch circle 2 x (300 + 8), leg width 10 % of the outside radius
    expect(support(legs)).toEqual({ type: 'legs', count: 4, height: 1000, pitchDiameter: 616, legWidth: 30.8 });
    expect(partsOf(legs).filter((part) => part.startsWith('lug-'))).toEqual([]);
  });

  it('exports exactly 8 more extruded solids than the same exchanger without lugs', () => {
    const plain = apply(mmDocument(), 'add_heat_exchanger', { ...exchanger, support: { type: 'none', baseElevation: 2000 } });
    const count = (d: CadDocument): number =>
      data<{ ifc: string }>(d, 'export_ifc', { timestamp: '2026-01-01T00:00:00' }).ifc.match(/IFCEXTRUDEDAREASOLID/g)?.length ?? 0;
    expect(count(doc) - count(plain)).toBe(8);
  });

  it('is pure and survives a save / load with the same derived entities', () => {
    const input = mmDocument();
    const before = JSON.stringify(input);
    execute(input, 'add_heat_exchanger', exchanger);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(deserializeDocument(serializeDocument(doc)).entities)).toBe(JSON.stringify(doc.entities));
  });

  it('load validation fit-checks the lugs of an exchanger (elevation, count, fixed-tubesheet shell range)', () => {
    const stored = JSON.parse(serializeDocument(doc)) as {
      document: { building: { elements: Record<string, { plant: { template: { support: Record<string, unknown> } } }> } };
    };
    const reject = (change: (support: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(stored)) as typeof stored;
      change(
        (Object.values(copy.document.building.elements)[0] as NonNullable<(typeof copy.document.building.elements)[string]>).plant.template
          .support,
      );
      try {
        deserializeDocument(JSON.stringify(copy));
      } catch (error) {
        return String(error);
      }
      return '';
    };
    expect(reject((s) => (s['lugElevation'] = 99999))).toMatch(/must lie on the shell/);
    expect(reject((s) => (s['lugElevation'] = 100))).toMatch(/must lie on the shell/);
    expect(reject((s) => (s['count'] = 400))).toMatch(/count <= 24/);
    expect(reject(() => undefined)).toBe('');
  });

  it('refuses lugs on a horizontal exchanger', () => {
    expectRefusal(mmDocument(), 'add_heat_exchanger', { ...bemParams, support: lugs }, 'EQP_SUPPORT_INVALID', 'support.type');
  });
});

describe('load validation of lugs', () => {
  const stored = JSON.parse(serializeDocument(apply(mmDocument(), 'add_vessel', { ...separatorParams, support: lugs }))) as {
    document: {
      building: { elements: Record<string, { plant: { template: { support: Record<string, unknown> } & Record<string, unknown> } }> };
    };
  };
  const rejects = (change: (support: Record<string, unknown>, template: Record<string, unknown>) => void): string => {
    const copy = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const element = Object.values(copy.document.building.elements)[0];
    const { template } = (element as NonNullable<typeof element>).plant;
    change(template.support, template);
    try {
      deserializeDocument(JSON.stringify(copy));
    } catch (error) {
      return String(error);
    }
    return '';
  };

  it.each([
    ['a lug floating far above the shell', (s: Record<string, unknown>) => (s['lugElevation'] = 99999), /lug .* must lie on the shell/],
    ['400 lugs of width 1000', (s: Record<string, unknown>) => ((s['count'] = 400), (s['lugWidth'] = 1000)), /count <= 24/],
    [
      'lugs on a horizontal vessel',
      (_s: Record<string, unknown>, t: Record<string, unknown>) => (t['orientation'] = 'horizontal'),
      /vertical body only/,
    ],
    ['24 lugs wider than the circumference', (s: Record<string, unknown>) => ((s['count'] = 24), (s['lugWidth'] = 250)), /circumference/],
    ['a zero thickness', (s: Record<string, unknown>) => (s['lugThickness'] = 0), /lugThickness must be a number > 0/],
    ['one lug', (s: Record<string, unknown>) => (s['count'] = 1), /count must be an integer >= 2/],
    ['a base plate as thick as the lug', (s: Record<string, unknown>) => (s['lugBasePlateThickness'] = 300), /below lugHeight/],
    [
      'a bolt hole wider than the lug',
      (s: Record<string, unknown>) => (s['lugBoltHoleDiameter'] = 500),
      /lugBoltHoleDiameter .* below \(lugWidth - lugThickness\) \/ 2/,
    ],
    [
      'a bolt hole beside the web that does not fit',
      (s: Record<string, unknown>) => (s['lugBoltHoleDiameter'] = 100),
      /beside|middle of the base plate/,
    ],
    ['a bolt hole of 0', (s: Record<string, unknown>) => (s['lugBoltHoleDiameter'] = 0), /lugBoltHoleDiameter must be a number > 0/],
  ])('rejects %s', (_name, change, message) => {
    expect(rejects(change)).toMatch(message);
  });

  it('the intact lugs load', () => {
    expect(rejects(() => undefined)).toBe('');
  });
});

describe('kettle weir plate and liquid level', () => {
  const kettle = {
    ...bemParams,
    tag: 'E-402',
    temaType: 'AKU',
    rearChannel: undefined,
    support: undefined,
    kettle: { enlargedInsideDiameter: 900, enlargedLength: 2000, transitionLength: 300, enlargedThickness: 10, weirHeight: 500 },
  };
  const withWeir = { ...kettle, kettle: { ...kettle.kettle, weirStation: 400, weirThickness: 12 } };
  const doc = apply(mmDocument(), 'add_heat_exchanger', withWeir);
  const plain = apply(mmDocument(), 'add_heat_exchanger', { ...kettle, tag: 'E-403' });
  const R = 450;
  const h = 500;
  // area and first moment about the axis of the segment below the chord at y = h - R, by midpoint integration of the chord width
  const steps = 400000;
  const dy = h / steps;
  let area = 0;
  let moment = 0;
  for (let i = 0; i < steps; i++) {
    const y = -R + (i + 0.5) * dy;
    const width = 2 * Math.sqrt(R * R - y * y);
    area += width * dy;
    moment += y * width * dy;
  }

  it('the plate is an extrusion of the circular segment, weir thickness deep, with the segment area of the hand calculation', () => {
    const weir = entityOf<ExtrusionEntity>(doc, 'weir');
    expect(weir.depth).toBe(12);
    const ys = weir.profile.map((point) => point[1]);
    expect(Math.min(...ys)).toBeCloseTo(-R, 6);
    expect(Math.max(...ys)).toBeCloseTo(h - R, 6);
    // closed form: R^2 acos((R - h) / R) - (R - h) sqrt(2 R h - h^2)
    const closed = R * R * Math.acos((R - h) / R) - (R - h) * Math.sqrt(2 * R * h - h * h);
    expect(rel(closed, area)).toBeLessThan(1e-6);
    const ring = weir.profile;
    const shoelace = ring.reduce((sum, point, i) => {
      const next = ring[(i + 1) % ring.length] as readonly [number, number];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    expect(rel(Math.abs(shoelace) / 2, area)).toBeLessThan(2e-3);
    expect(partsOf(plain)).not.toContain('weir');
  });

  it('the plate stands across the shell axis: the profile y is up, the depth runs along the shell axis', () => {
    const weir = entityOf<ExtrusionEntity>(doc, 'weir');
    const [x, y, z] = applyEulerXYZ([0, -R, 12], [0, 0, 0], weir.rotation);
    expect([x, y, z].map((value) => Math.round(value * 1e6) / 1e6 + 0)).toEqual([12, 0, -R]);
  });

  it('the weir weight enters the empty weight and sits at the segment centroid, 600 toward the rear from the enlarged cylinder centre', () => {
    const extra = weightsOf(doc, 'E-402').body.emptyKg - weightsOf(plain, 'E-403').body.emptyKg;
    expect(rel(extra, area * 12 * STEEL)).toBeLessThan(1e-6);
    const parts = cogOf(doc, 'E-402').parts;
    const weir = parts.find((part) => part.part === 'weir');
    const enlarged = parts.find((part) => part.part === 'kettleShell');
    // the enlarged cylinder centroid is 1000 from the rear end of the shell, the plate centre 400
    expect((weir?.local[0] as number) - (enlarged?.local[0] as number)).toBeCloseTo(600, 6);
    expect((weir?.local[2] as number) - (enlarged?.local[2] as number)).toBeCloseTo(moment / area, 4);
  });

  it('reports the liquid volume up to the weir on the bundle side and says the bundle displacement is not subtracted', () => {
    const volume = data<{ kettleWeir: { liquidVolumeToWeirM3: number; liquidLength: number; note: string } }>(doc, 'vessel_volume', {
      equipment: 'E-402',
    }).kettleWeir;
    // bundle side of the plate: 2000 - (400 + 12 / 2)
    expect(volume.liquidLength).toBeCloseTo(1594, 9);
    expect(rel(volume.liquidVolumeToWeirM3, (area * 1594) / 1e9)).toBeLessThan(1e-6);
    expect(volume.note).toContain('bundle displacement not subtracted');
    expect(execute(doc, 'vessel_volume', { equipment: 'E-402' }).summary).toContain('bundle displacement not subtracted');
    expect(data(plain, 'vessel_volume', { equipment: 'E-403' })).not.toHaveProperty('kettleWeir');
  });

  it('is exported to IFC as a solid without a warning', () => {
    const ifc = data<{ warnings: unknown[]; ifc: string }>(doc, 'export_ifc', { timestamp: '2026-01-01T00:00:00' });
    expect(ifc.warnings).toEqual([]);
    expect(ifc.ifc).toContain('IFCEXTRUDEDAREASOLID');
  });

  it.each([
    ['a weir that starts before the rear end', { weirStation: 5, weirThickness: 12 }, 'EQP_WEIR_OUT_OF_RANGE', 'kettle.weirStation'],
    ['a weir past the enlarged length', { weirStation: 1998, weirThickness: 12 }, 'EQP_WEIR_OUT_OF_RANGE', 'kettle.weirStation'],
    ['a weir station without a thickness', { weirStation: 400 }, 'EQP_PARAM_INVALID', 'kettle.weirThickness'],
    ['a weir thickness without a station', { weirThickness: 12 }, 'EQP_PARAM_INVALID', 'kettle.weirStation'],
  ])('refuses %s by name and leaves the document unchanged', (_name, patch, code, path) => {
    expectRefusal(mmDocument(), 'add_heat_exchanger', { ...kettle, kettle: { ...kettle.kettle, ...patch } }, code, path);
  });

  it('a revision that shortens the enlarged shell under the weir is refused; the weir survives an unrelated revision', () => {
    expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'E-402', exchanger: { kettle: { enlargedLength: 300 } } },
      'EQP_WEIR_OUT_OF_RANGE',
      'exchanger.kettle.weirStation',
    );
    const revised = apply(doc, 'update_equipment_parameters', { equipment: 'E-402', exchanger: { shellThickness: 9 } });
    expect(equipmentOf(revised, 'E-402').plant?.template).toMatchObject({ kettle: { weirStation: 400, weirThickness: 12 } });
  });

  it('is pure, survives a save / load with the same derived entities, and a rotated weir stands across the rotated shell axis', () => {
    const input = mmDocument();
    const before = JSON.stringify(input);
    execute(input, 'add_heat_exchanger', withWeir);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(deserializeDocument(serializeDocument(doc)).entities)).toBe(JSON.stringify(doc.entities));
    const turned = apply(mmDocument(), 'add_heat_exchanger', { ...withWeir, location: [1000, 2000], planRotationDeg: 30 });
    const weir = entityOf<ExtrusionEntity>(turned, 'weir');
    const shell = entityOf<{ axis: [number, number, number]; rotation: [number, number, number] }>(turned, 'kettleShell');
    const depth = applyEulerXYZ([0, 0, 1], [0, 0, 0], weir.rotation);
    const axis = applyEulerXYZ(shell.axis, [0, 0, 0], shell.rotation);
    expect(Math.abs(axis[0]) + Math.abs(axis[1])).toBeGreaterThan(0.99);
    depth.forEach((value, index) => expect(value).toBeCloseTo(axis[index] as number, 9));
    // the profile y stays vertical
    expect(applyEulerXYZ([0, 1, 0], [0, 0, 0], weir.rotation)[2]).toBeCloseTo(1, 9);
  });

  it('weirStation: null removes the weir plate and keeps weirHeight; the volume then has no kettleWeir block', () => {
    const removed = apply(doc, 'update_equipment_parameters', { equipment: 'E-402', exchanger: { kettle: { weirStation: null } } });
    expect(partsOf(removed)).not.toContain('weir');
    const template = equipmentOf(removed, 'E-402').plant?.template as unknown as { kettle: Record<string, unknown> };
    expect(template.kettle).toEqual({
      enlargedInsideDiameter: 900,
      enlargedLength: 2000,
      transitionLength: 300,
      enlargedThickness: 10,
      weirHeight: 500,
    });
    expect(data(removed, 'vessel_volume', { equipment: 'E-402' })).not.toHaveProperty('kettleWeir');
    expect(weightsOf(removed, 'E-402').body.emptyKg).toBeCloseTo(weightsOf(plain, 'E-403').body.emptyKg, 9);
    expect(data<{ kettleWeir: { note: string } }>(doc, 'vessel_volume', { equipment: 'E-402' }).kettleWeir.note).toContain(
      'cuts through it',
    );
  });

  it('load validation rejects a weir outside the enlarged length and a half-given weir', () => {
    const stored = JSON.parse(serializeDocument(doc)) as {
      document: { building: { elements: Record<string, { plant: { template: { kettle: Record<string, unknown> } } }> } };
    };
    const reject = (change: (kettleRecord: Record<string, unknown>) => void): string => {
      const copy = JSON.parse(JSON.stringify(stored)) as typeof stored;
      const element = Object.values(copy.document.building.elements)[0];
      change((element as NonNullable<typeof element>).plant.template.kettle);
      try {
        deserializeDocument(JSON.stringify(copy));
      } catch (error) {
        return String(error);
      }
      return '';
    };
    expect(reject((k) => (k['weirStation'] = 3))).toMatch(/outside the enlarged length/);
    expect(reject((k) => delete k['weirThickness'])).toMatch(/given together or not at all/);
    expect(reject(() => undefined)).toBe('');
  });
});
