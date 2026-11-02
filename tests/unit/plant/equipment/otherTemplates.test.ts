/**
 * Plant 03 EQP M4 (TR-EQP-02, TR-EQP-03): exchangers, tanks and pumps keep the legacy equipment consumers working (schedule, clashes, IFC, load-time
 * validation) and a corrupt plant record of those templates is rejected with a description at load, never a crash in regeneration.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import { apply, data } from '../../../helpers/commandAssertions';
import { bemDocument, mmDocument, pumpParams, tankParams } from './equipmentFixtures';

const plantDocument = (): CadDocument =>
  apply(apply(bemDocument(), 'add_storage_tank', tankParams), 'add_pump', { ...pumpParams, location: [9000, 9000] });

describe('legacy equipment consumers keep working on exchangers, tanks and pumps', () => {
  const doc = plantDocument();

  it('the building model passes the load-time validation, also after a JSON round trip', () => {
    expect(buildingErrors(JSON.parse(JSON.stringify(doc.building)))).toEqual([]);
  });

  it('the equipment schedule lists the derived size, weight and shape of every kind', () => {
    const schedule = data<{ rows: unknown[][] }>(doc, 'building_schedule', { kind: 'equipment' });
    const row = (tag: string): unknown[] | undefined => schedule.rows.find((candidate) => candidate[0] === tag);
    expect(row('E-301')?.[5]).toBe('5793×616×1308');
    expect(String(row('T-401')?.[5])).toMatch(/^20012×20012×12839.83/);
    expect(row('T-401')?.[8]).toBe('vertical_vessel');
    expect(row('P-101')?.[5]).toBe('1500×600×555');
    expect(Number(row('P-101')?.[7])).toBe(310);
  });

  it('check_clashes sees the derived bounding boxes: a skid dropped on the tank and one dropped on the exchanger both clash', () => {
    const crowded = apply(
      apply(doc, 'add_equipment', { name: 'Skid A', mark: 'S-1', location: [30000, 0], size: [1000, 1000, 1000] }),
      'add_equipment',
      { name: 'Skid B', mark: 'S-2', location: [0, 8000], size: [500, 500, 500] },
    );
    const { clashes } = data<{ clashes: Array<{ a: string; b: string }> }>(crowded, 'check_clashes', {});
    const pairs = clashes.map((clash) => [clash.a, clash.b].sort().join('|'));
    expect(pairs).toEqual(expect.arrayContaining(['equipment-2|equipment-4', 'equipment-1|equipment-5']));
  });

  it('export_ifc exports each as a product', () => {
    expect(data<{ productCount: number }>(doc, 'export_ifc', {}).productCount).toBe(3);
  });
});

describe('load: a corrupt plant record of a new template is rejected with a description, never a crash', () => {
  const stored = JSON.parse(serializeDocument(plantDocument())) as {
    document: { building: { elements: Record<string, { plant: { template: Record<string, unknown> } & Record<string, unknown> }> } };
  };
  const reject = (id: string, change: (plant: Record<string, unknown>, template: Record<string, unknown>) => void): unknown => {
    const copy = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const plant = copy.document.building.elements[id]?.plant as { template: Record<string, unknown> } & Record<string, unknown>;
    change(plant, plant.template);
    try {
      deserializeDocument(JSON.stringify(copy));
    } catch (error) {
      return error;
    }
    return undefined;
  };
  const tubes = (template: Record<string, unknown>): Record<string, unknown> => template['tubes'] as Record<string, unknown>;
  const side = (template: Record<string, unknown>): Record<string, unknown> => template['design'] as Record<string, unknown>;
  const shell = (template: Record<string, unknown>): Record<string, unknown> => side(template)['shellSide'] as Record<string, unknown>;

  it.each([
    [
      'exchanger without tema',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['tema'],
      /tema needs front, shell, rear/,
    ],
    [
      'exchanger tube wall without bore',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (tubes(t)['wallThickness'] = 10),
      /leaves no bore/,
    ],
    [
      'exchanger tubes too short',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (tubes(t)['length'] = 90),
      /leaves no shell/,
    ],
    [
      'exchanger with a skirt',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) =>
        (t['support'] = { type: 'skirt', height: 1, thickness: 1, baseRingWidth: 0 }),
      /saddles or none/,
    ],
    [
      'fixed exchanger without a rear channel',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['rearChannel'],
      /rearChannel/,
    ],
    [
      'exchanger channel without thickness',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['frontChannel'] as Record<string, unknown>)['thickness'],
      /frontChannel\.thickness/,
    ],
    [
      'channel nozzle without a channel',
      'equipment-1',
      (p: Record<string, unknown>) => delete ((p['nozzles'] as Array<{ location: Record<string, unknown> }>)[2]?.location ?? {})['channel'],
      /channel location needs channel/,
    ],
    [
      'tank without courses',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['courses'],
      /courses must be a non-empty array/,
    ],
    ...['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'].map(
      (kind) =>
        [
          `template kind ${kind}`,
          'equipment-1',
          (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['kind'] = kind),
          /template\.kind/,
        ] as const,
    ),
    [
      'exchanger without defaulted',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['defaulted'],
      /defaulted must be an array of strings/,
    ],
    [
      'exchanger defaulted with a number',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['defaulted'] = [1]),
      /defaulted must be an array of strings/,
    ],
    [
      'tema front of two letters',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => ((t['tema'] as Record<string, unknown>)['front'] = 'BB'),
      /tema needs front, shell, rear/,
    ],
    [
      'tema without removableBundle',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['tema'] as Record<string, unknown>)['removableBundle'],
      /tema needs front, shell, rear/,
    ],
    [
      'tubes layout angle 50',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (tubes(t)['layoutAngleDeg'] = 50),
      /layoutAngleDeg/,
    ],
    [
      'tubes passes 0',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (tubes(t)['passes'] = 0),
      /tubes\.passes/,
    ],
    [
      'tubes without wallSource',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete tubes(t)['wallSource'],
      /wallSource/,
    ],
    [
      'tubes wallUnverified a string',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (tubes(t)['wallUnverified'] = 'no'),
      /wallUnverified/,
    ],
    [
      'exchanger design not an object',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['design'] = 5),
      /design must be an object/,
    ],
    [
      'shellSide not an object',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (side(t)['shellSide'] = 'x'),
      /shellSide must be an object/,
    ],
    [
      'shellSide pressure with a bad unit',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['pressure'] = { value: 1, unit: 'atm' }),
      /shellSide\.pressure/,
    ],
    [
      'shellSide allowable stress negative',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['allowableStress'] = { value: -1, unit: 'MPa' }),
      /allowableStress/,
    ],
    [
      'shellSide stress at test bad',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['allowableStressAtTest'] = 'x'),
      /allowableStressAtTest/,
    ],
    [
      'shellSide efficiency above 1',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['jointEfficiency'] = { shell: 2, heads: 1 }),
      /jointEfficiency/,
    ],
    [
      'shellSide temperature a string',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['temperatureC'] = 'hot'),
      /temperatureC/,
    ],
    [
      'shellSide material a number',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['material'] = 7),
      /material/,
    ],
    [
      'shellSide gravity zero',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (shell(t)['specificGravity'] = 0),
      /specificGravity/,
    ],
    [
      'exchanger density negative',
      'equipment-1',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (side(t)['materialDensityKgM3'] = -1),
      /materialDensityKgM3/,
    ],
    [
      'tank without defaulted',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['defaulted'],
      /defaulted must be an array of strings/,
    ],
    [
      'tank thickness source unknown',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['thicknessSource'] = 'guess'),
      /thicknessSource/,
    ],
    [
      'tank without corrosion allowance',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['design'] as Record<string, unknown>)['corrosionAllowance'],
      /corrosionAllowance >= 0/,
    ],
    [
      'tank negative corrosion allowance',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => ((t['design'] as Record<string, unknown>)['corrosionAllowance'] = -1),
      /corrosionAllowance >= 0/,
    ],
    [
      'tank allowable stress without test',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) =>
        ((t['design'] as Record<string, unknown>)['allowableStress'] = { design: 160 }),
      /allowableStress needs/,
    ],
    [
      'tank allowable stress source a number',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) =>
        ((t['design'] as Record<string, unknown>)['allowableStress'] = { design: 160, test: 171, source: 3 }),
      /allowableStress needs/,
    ],
    [
      'tank density negative',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => ((t['design'] as Record<string, unknown>)['materialDensityKgM3'] = -5),
      /materialDensityKgM3/,
    ],
    [
      'pump without defaulted',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['defaulted'],
      /defaulted must be an array of strings/,
    ],
    [
      'pump envelope without rating',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['envelope'] as Record<string, unknown>)['rating'],
      /envelope\.rating/,
    ],
    [
      'pump envelope grade Z',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => ((t['envelope'] as Record<string, unknown>)['grade'] = 'Z'),
      /envelope\.grade/,
    ],
    [
      'pump envelope without source',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['envelope'] as Record<string, unknown>)['source'],
      /envelope\.source/,
    ],
    ['pump weight negative', 'equipment-3', (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['weightKg'] = -1), /weightKg/],
    [
      'tank courses that do not add up',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['shellHeight'] = 5000),
      /courses must add up to shellHeight/,
    ],
    [
      'pump driver without a gap',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['driver'] as Record<string, unknown>)['gap'],
      /driver\.gap/,
    ],
    [
      'tank with a thickness per course missing',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['courseThicknesses'] = [6]),
      /one number > 0 per course/,
    ],
    [
      'tank with an unknown roof',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['roof'] = { type: 'umbrella', thickness: 5 }),
      /roof needs type/,
    ],
    [
      'cone roof without slope',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete (t['roof'] as Record<string, unknown>)['slope'],
      /cone needs slope/,
    ],
    ['tank without design', 'equipment-2', (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['design'], /design needs/],
    [
      'tank without bottom',
      'equipment-2',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['bottom'],
      /bottom\.thickness/,
    ],
    [
      'pump without envelope',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['envelope'],
      /envelope must be an object/,
    ],
    [
      'pump envelope with a zero',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => ((t['envelope'] as Record<string, unknown>)['h1'] = 0),
      /envelope\.h1/,
    ],
    [
      'pump without baseplate',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => delete t['baseplate'],
      /baseplate must be an object/,
    ],
    [
      'pump driver not an object',
      'equipment-3',
      (_p: Record<string, unknown>, t: Record<string, unknown>) => (t['driver'] = 5),
      /driver must be an object/,
    ],
  ])('%s', (_name, id, change, message) => {
    const failure = reject(id, change);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(TypeError);
    expect(String(failure)).toMatch(message);
  });

  it('derived solids of every kind equal what a load re-derives', () => {
    const doc = plantDocument();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(JSON.stringify(loaded.entities)).toBe(JSON.stringify(doc.entities));
    expect(loaded.order).toEqual(doc.order);
  });

  it('the intact documents load', () => {
    expect(reject('equipment-1', () => undefined)).toBeUndefined();
    expect(mmDocument().building).toBeUndefined();
  });
});
