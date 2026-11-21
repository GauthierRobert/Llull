/**
 * Plant 03 EQP-PID-FU2 review round: a defaulted rear channel, revisions of kettles and defaulted walls, the vertical bundle-pull zone and the kettle-cone note.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { bemParams, mmDocument } from './equipmentFixtures';

const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const templateOf = (doc: CadDocument, tag: string): Record<string, unknown> =>
  (equipmentOf(doc, tag).plant?.template ?? {}) as unknown as Record<string, unknown>;
const emptyKg = (doc: CadDocument, equipment: string): number =>
  data<{ body: { emptyKg: number } }>(doc, 'equipment_weights', { equipment }).body.emptyKg;

const kettleInput = { enlargedInsideDiameter: 900, enlargedLength: 2000, transitionLength: 300, enlargedThickness: 10, weirHeight: 500 };
const kettle = { ...bemParams, tag: 'E-402', temaType: 'AKU', rearChannel: undefined, support: undefined, kettle: kettleInput };
const vertical = {
  ...bemParams,
  tag: 'E-414',
  temaType: 'AES',
  rearChannel: undefined,
  orientation: 'vertical',
  support: { type: 'skirt', height: 1000 },
  clearance: 0,
};
const footprint = [
  [-3000, 5000],
  [3000, 5000],
  [3000, 11000],
  [-3000, 11000],
];
const clearances = (doc: CadDocument): number =>
  data<{ clashes: Array<{ kind: string }> }>(doc, 'check_clashes', {}).clashes.filter((clash) => clash.kind === 'clearance').length;

describe('defaulted rear channel', () => {
  const front = { length: 300, thickness: 20, coverThickness: 60 };

  it('copies only the front length and wall: DEM builds without a rearChannel, DEL gets a plain flat rear cover', () => {
    const dem = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tag: 'E-410',
      temaType: 'DEM',
      frontChannel: front,
      rearChannel: undefined,
    });
    expect(templateOf(dem, 'E-410')['rearChannel']).toEqual({ length: 300, thickness: 20 });
    const del = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tag: 'E-411',
      temaType: 'DEL',
      frontChannel: front,
      rearChannel: undefined,
    });
    expect(templateOf(del, 'E-411')['rearChannel']).toEqual({ length: 300, thickness: 20 });
    const plain = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tag: 'E-412',
      temaType: 'DEL',
      frontChannel: { length: 300, thickness: 20, coverThickness: 20 },
      rearChannel: undefined,
    });
    // only the front cover is thicker (60 against 20): disc of the outside radius 320 x 40 mm of steel
    expect(emptyKg(del, 'E-411') - emptyKg(plain, 'E-412')).toBeCloseTo(Math.PI * 320 ** 2 * 40 * 1e-9 * 7850, 6);
  });
});

describe('update_equipment_parameters on kettles and defaulted walls', () => {
  it('back to an E shell drops the kettle; AEU -> AKU needs the whole kettle and accepts a complete one', () => {
    const doc = apply(mmDocument(), 'add_heat_exchanger', kettle);
    const back = apply(doc, 'update_equipment_parameters', { equipment: 'E-402', exchanger: { temaType: 'AEU' } });
    expect(templateOf(back, 'E-402')).not.toHaveProperty('kettle');
    const plain = apply(mmDocument(), 'add_heat_exchanger', { ...kettle, tag: 'E-413', temaType: 'AEU', kettle: undefined });
    expectRefusal(
      plain,
      'update_equipment_parameters',
      { equipment: 'E-413', exchanger: { temaType: 'AKU', kettle: { weirHeight: 300 } } },
      'EQP_PARAM_INVALID',
      'exchanger.kettle.enlargedInsideDiameter',
    );
    const made = apply(plain, 'update_equipment_parameters', { equipment: 'E-413', exchanger: { temaType: 'AKU', kettle: kettleInput } });
    expect(templateOf(made, 'E-413')).toMatchObject({ kettle: { weirHeight: 500 } });
  });

  it('a wall that was only a named default follows the revised shell wall; giving it removes it from defaulted', () => {
    const doc = apply(mmDocument(), 'add_heat_exchanger', { ...kettle, kettle: { ...kettleInput, enlargedThickness: undefined } });
    const revised = apply(doc, 'update_equipment_parameters', { equipment: 'E-402', exchanger: { shellThickness: 12 } });
    expect(templateOf(revised, 'E-402')).toMatchObject({
      shellThickness: 12,
      kettle: { enlargedThickness: 12 },
      frontChannel: { thickness: 12 },
    });
    expect(templateOf(revised, 'E-402')['defaulted']).toEqual(
      expect.arrayContaining(['kettle.enlargedThickness', 'frontChannel.thickness']),
    );
    const given = apply(revised, 'update_equipment_parameters', { equipment: 'E-402', exchanger: { kettle: { enlargedThickness: 14 } } });
    expect(templateOf(given, 'E-402')['defaulted']).not.toContain('kettle.enlargedThickness');
    expect(templateOf(given, 'E-402')).toMatchObject({ kettle: { enlargedThickness: 14 } });
  });
});

describe('bundle pull of a vertical exchanger', () => {
  const doc = apply(mmDocument(), 'add_heat_exchanger', vertical);

  it('goes out of the top: a skid on a deck above the top is a clearance clash, a skid on the floor and a floor slab under the front head are not', () => {
    expect(clearances(doc)).toBe(0);
    const floor = apply(doc, 'add_equipment', { name: 'Skid', mark: 'S-9', location: [0, 8000], size: [300, 300, 300], clearance: 0 });
    expect(clearances(floor)).toBe(0);
    const slab = apply(doc, 'add_slab', { boundary: footprint, thickness: 200, role: 'floor' });
    expect(data<{ clashes: unknown[] }>(slab, 'check_clashes', {}).clashes).toEqual([]);
    // the zone runs from the end of the shell (z 6127) 5877 upward: a deck skid at 9000 is inside it, one at 13000 is beyond it
    const withDeck = apply(doc, 'add_level', { name: 'Deck', elevation: 9000, makeActive: false });
    const deckId = Object.keys(withDeck.building?.levels ?? {}).find((id) => withDeck.building?.levels[id]?.elevation === 9000) as string;
    const onDeck = (document: CadDocument, id: string): CadDocument =>
      apply(document, 'add_equipment', {
        name: 'Deck skid',
        mark: 'S-10',
        location: [0, 8000],
        size: [300, 300, 300],
        clearance: 0,
        levelId: id,
      });
    expect(clearances(onDeck(withDeck, deckId))).toBe(1);
    const high = apply(doc, 'add_level', { name: 'High', elevation: 13000, makeActive: false });
    const highId = Object.keys(high.building?.levels ?? {}).find((id) => high.building?.levels[id]?.elevation === 13000) as string;
    expect(clearances(onDeck(high, highId))).toBe(0);
  });
});

describe('nozzle_reinforcement on a kettle', () => {
  const rated = {
    design: {
      shellSide: {
        pressure: { value: 1, unit: 'MPa' },
        temperatureC: 120,
        allowableStress: { value: 138, unit: 'MPa', source: 'test' },
        jointEfficiency: { shell: 1, heads: 1 },
      },
    },
  };
  const withNozzle = (params: object, tag: string): CadDocument =>
    apply(apply(mmDocument(), 'add_heat_exchanger', { ...params, ...rated, tag }), 'add_nozzle', {
      equipment: tag,
      mark: 'V1',
      dn: 100,
      rating: 'CL150',
      location: { on: 'shell', station: 2600, orientationDeg: 0 },
      projection: 700,
    });

  it('names the equivalent-cylinder approximation for the kettle cone, and nothing for a plain exchanger', () => {
    const k = data<{ approximations?: string[] }>(withNozzle(kettle, 'E-402'), 'nozzle_reinforcement', { equipment: 'E-402' });
    expect(k.approximations?.[0]).toMatch(/kettle cone/);
    const plain = data<{ approximations?: string[] }>(
      withNozzle({ ...kettle, temaType: 'AEU', kettle: undefined }, 'E-415'),
      'nozzle_reinforcement',
      { equipment: 'E-415' },
    );
    expect(plain.approximations).toBeUndefined();
  });
});
