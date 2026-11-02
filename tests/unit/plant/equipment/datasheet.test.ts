/**
 * Plant 03 EQP M5 (FR-EQP-13): `equipment_datasheet` of the five equipment kinds. The sheet carries the numbers of the registered queries (one source of
 * truth), lengths in millimetres whatever the document unit, a refused query as an `available: false` section (never omitted), the review flags, CSV with the
 * spreadsheet formula guard, byte-deterministic output and coded refusals.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { sha256Hex } from '@lib/sha256';
import { arrayAt, at, rowsAt, textAt, type JsonObject } from '../../../helpers/json';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import {
  bemDocument,
  mmDocument,
  pumpDocument,
  pumpParams,
  separatorDocument,
  separatorNozzles,
  separatorParams,
  tankDocument,
} from './equipmentFixtures';

type Json = JsonObject;
const sheet = (doc: Parameters<typeof data>[0], equipment: string, extra: Record<string, unknown> = {}): Json =>
  data<Json>(doc, 'equipment_datasheet', { equipment, ...extra });
const csvRows = (text: string): string[][] => text.split('\n').map((line) => line.split(','));

describe('equipment_datasheet of the SC-EQP-01 separator', () => {
  const doc = separatorDocument();
  const result = sheet(doc, 'V-101');

  it('identifies the equipment and lists the four nozzles with port id, position and direction in millimetres', () => {
    expect(at(result, 'schema')).toBe('llull-equipment-datasheet/1');
    expect(at(result, 'identification')).toMatchObject({
      tag: 'V-101',
      name: 'HP separator',
      template: 'vessel',
      orientation: 'vertical',
      level: 'Level 0',
    });
    expect(at(result, 'nozzles')).toHaveLength(4);
    const n1 = rowsAt(result, 'nozzles')[0];
    expect(n1).toMatchObject({
      mark: 'N1',
      portId: 'V-101:N1',
      service: 'inlet',
      dn: 150,
      rating: 'CL150',
      facing: 'RF',
      orientationDeg: 0,
      projectionMm: 1000,
      positionMm: [5000, 6000, 5200],
      direction: [0, 1, 0],
    });
    expect(at(n1, 'flange')).toMatchObject({ outsideDiameterMm: 279.4, thicknessMm: 23.9, placeholder: false, unverified: true });
  });

  it('shows the numbers of the queries it composes (weights, volume, thickness, check), not recomputed ones', () => {
    const weights = data<Json>(doc, 'equipment_weights', { equipment: 'V-101', include: ['body', 'nozzles'] });
    expect(at(result, 'weights.body')).toEqual(at(weights, 'body'));
    expect(
      rowsAt(result, 'weights.breakdown')
        .map((line) => at(line, 'method'))
        .every((method) => typeof method === 'string' && method.length > 0),
    ).toBe(true);
    const volume = data<Json>(doc, 'vessel_volume', { equipment: 'V-101' });
    expect(at(result, 'volumes.totalVolumeM3')).toBe(at(volume, 'totalVolumeM3'));
    expect(at(result, 'volumes.insideHeightMm')).toBe(at(volume, 'insideHeight'));
    const thickness = data<Json>(doc, 'vessel_thickness', { equipment: 'V-101' });
    expect(at(result, 'codeResults.thickness.mawpMPa')).toBe(at(thickness, 'mawpMPa'));
    expect(at(result, 'codeResults.thickness.hydrotestPressureMPa')).toBe(at(thickness, 'hydrotestPressureMPa'));
    const check = data<Json>(doc, 'check_equipment', { equipment: ['V-101'] });
    expect(at(result, 'codeResults.check')).toMatchObject({
      status: at(check, 'status'),
      issues: at(check, 'issues'),
      reviewRequired: true,
    });
  });

  it('lists the design inputs with their source, the geometry in mm and the inside surface area', () => {
    expect(at(result, 'design')).toMatchObject({
      pressure: { value: 1, unit: 'MPa' },
      temperatureC: 150,
      material: 'SA-516 Gr 70',
      allowableStress: { value: 137.9, unit: 'MPa', source: 'user input' },
      jointEfficiency: { shell: 1, heads: 1 },
      corrosionAllowanceMm: 3,
      missing: [],
    });
    expect(at(result, 'geometry')).toMatchObject({
      kind: 'vessel',
      insideDiameterMm: 1500,
      tangentLengthMm: 4000,
      shellThicknessMm: 10,
      support: { type: 'skirt', heightMm: 2000, thicknessMm: 10 },
    });
    // shell 2 pi R L + two 2:1 heads (pi R^2 + pi a^2 / (2 e) ln((1+e)/(1-e)), a = D/4)
    expect(at(result, 'geometry.insideSurfaceAreaM2')).toBeCloseTo(23.727489942, 9);
  });

  it('always requires review, says why, and flags the unverified flange rows and the named defaults', () => {
    expect(at(result, 'review')).toMatchObject({ status: 'not_reviewed', reviewRequired: true, unverified: true });
    expect(at(result, 'review.reasons')).toContain('ASME VIII-1 thickness computed by llull from the cited formulas; not a stamped design');
    expect(at(result, 'review.defaulted')).toContain('test water density = 1000 kg/m3 (named default)');
    expect(at(result, 'provenance.units')).toMatchObject({ length: 'mm', volume: 'm3', mass: 'kg' });
    expect(at(result, 'warnings')).toEqual([]);
  });

  it('is a query: the document is returned unchanged and nothing is affected', () => {
    const run = execute(doc, 'equipment_datasheet', { equipment: 'V-101' });
    expect(run.document).toBe(doc);
    expect(run.affected).toEqual([]);
    expectPure(doc, () => execute(doc, 'equipment_datasheet', { equipment: 'V-101', format: 'csv' }));
  });

  it('is byte-deterministic: the canonical JSON text, its sha256 and the file name are identical on a second call', () => {
    const again = sheet(doc, 'equipment-1');
    expect(textAt(again, 'text')).toBe(textAt(result, 'text'));
    expect(at(result, 'sha256')).toBe(sha256Hex(textAt(result, 'text')));
    expect(at(result, 'bytes')).toBe(new TextEncoder().encode(textAt(result, 'text')).length);
    expect(at(result, 'fileName')).toBe('V-101-datasheet.json');
    expect(JSON.parse(textAt(result, 'text'))).toMatchObject({ schema: 'llull-equipment-datasheet/1', nozzles: at(result, 'nozzles') });
    expect(Object.keys(JSON.parse(textAt(result, 'text')))).toEqual([...Object.keys(JSON.parse(textAt(result, 'text')))].sort());
  });

  it('reports angles in the requested convention', () => {
    const east = sheet(doc, 'V-101', { angleConvention: 'east_ccw' });
    expect(at(east, 'identification.angleConvention')).toBe('east_ccw');
    expect(at(rowsAt(east, 'nozzles')[0], 'orientationDeg')).toBe(90);
  });
});

describe('equipment_datasheet keeps a refused query as an unavailable section', () => {
  it('a vessel without design data: the design lists what is missing and the thickness section is { available: false, code }', () => {
    const { design: _design, ...bare } = separatorParams;
    const doc = apply(mmDocument(), 'add_vessel', bare);
    const result = sheet(doc, 'V-101');
    expect(at(result, 'design.missing')).toEqual(['pressure', 'temperatureC', 'material', 'allowableStress', 'jointEfficiency']);
    expect(at(result, 'codeResults.thickness')).toMatchObject({ available: false, reason: 'refused' });
    expect(typeof at(result, 'codeResults.thickness.code')).toBe('string');
    expect(arrayAt(result, 'codeResults.thickness.paths').length).toBeGreaterThan(0);
    expect(at(result, 'review.reviewRequired')).toBe(true);
  });

  it('a pump without a vendor weight: weights refused EQP_DESIGN_DATA_MISSING, volumes not applicable; with the weight both read', () => {
    const { weightKg: _weight, ...unweighed } = pumpParams;
    const refused = sheet(apply(mmDocument(), 'add_pump', unweighed), 'P-101');
    expect(at(refused, 'weights')).toMatchObject({ available: false, reason: 'refused', code: 'EQP_DESIGN_DATA_MISSING' });
    expect(at(refused, 'volumes')).toMatchObject({ available: false, reason: 'not_applicable' });
    const weighed = sheet(pumpDocument(), 'P-101');
    expect(at(weighed, 'weights.body.emptyKg')).toBe(310);
    expect(at(weighed, 'geometry')).toMatchObject({ kind: 'pump', standard: 'iso_2858', size: '65-40-250' });
    expect(at(weighed, 'design')).toMatchObject({ api610Type: 'OH1', rating: 'PN16' });
    expect(rowsAt(weighed, 'nozzles').map((row) => at(row, 'mark'))).toEqual(['SUC', 'DIS']);
    expect(at(weighed, 'codeResults.thickness')).toMatchObject({ available: false, reason: 'not_applicable' });
  });

  it('a nozzle without a placeable port keeps its row (null position) and raises a warning with its path', () => {
    const doc = separatorDocument();
    const element = Object.values(doc.building?.elements ?? {}).find((candidate) => candidate.category === 'equipment');
    if (element?.category !== 'equipment' || element.plant === undefined) throw new Error('fixture');
    const broken = {
      ...doc,
      building: {
        ...doc.building!,
        elements: {
          ...doc.building!.elements,
          [element.id]: {
            ...element,
            plant: {
              ...element.plant,
              nozzles: element.plant.nozzles.map((nozzle) =>
                nozzle.mark === 'N1'
                  ? {
                      ...nozzle,
                      location: {
                        on: 'free' as const,
                        position: [0, 0, 0] as [number, number, number],
                        direction: [0, 0, 0] as [number, number, number],
                      },
                    }
                  : nozzle,
              ),
            },
          },
        },
      },
    };
    const result = sheet(broken, 'V-101');
    expect(rowsAt(result, 'nozzles')[0]).toMatchObject({ mark: 'N1', portId: null, positionMm: null, direction: null });
    expect(at(result, 'warnings')).toEqual([expect.objectContaining({ code: 'EQP_PARAM_INVALID', paths: ['nozzles.N1'] })]);
  });
});

describe('equipment_datasheet of the other templates', () => {
  it('exchanger: both sides, channel nozzles, thickness judged inside check_equipment', () => {
    const result = sheet(bemDocument(), 'E-301');
    expect(at(result, 'identification')).toMatchObject({ template: 'exchanger', orientation: 'horizontal' });
    expect(at(result, 'geometry')).toMatchObject({ kind: 'exchanger', temaType: 'BEM', shellInsideDiameterMm: 600 });
    expect(at(result, 'volumes.shellSide.volumeM3')).toBeCloseTo(0.9421985298921338, 12);
    expect(at(result, 'volumes.tubeSide.volumeM3')).toBeCloseTo(0.511174882207871, 12);
    expect(at(result, 'design.shellSide')).toMatchObject({ pressure: { value: 1, unit: 'MPa' }, temperatureC: 120 });
    expect(at(result, 'design.shellSide.missing')).toContain('allowableStress');
    expect(at(result, 'codeResults.thickness')).toMatchObject({ available: false, reason: 'not_applicable' });
    expect(arrayAt(result, 'codeResults.check.notChecked').length).toBeGreaterThan(0);
    expect(rowsAt(result, 'nozzles').map((row) => at(row, 'mark'))).toEqual(['S1', 'S2', 'T1', 'T2']);
    expect(at(rowsAt(result, 'nozzles')[2], 'direction')).toEqual([0, 0, -1]);
  });

  it('tank: the course thicknesses of the one-foot method and the volumes at the design level', () => {
    const result = sheet(tankDocument(), 'T-401');
    expect(at(result, 'geometry')).toMatchObject({ kind: 'tank', diameterMm: 20000, shellHeightMm: 12000 });
    expect(arrayAt(result, 'geometry.courseThicknessesMm')[0]).toBeCloseTo(8.66625, 9);
    expect(at(rowsAt(result, 'codeResults.thickness.courses')[0], 'governingThicknessMm')).toBeCloseTo(8.66625, 9);
    expect(at(result, 'volumes.totalVolumeM3')).toBeCloseTo(3769.9111843077517, 6);
    expect(at(result, 'review.unverified')).toBe(true);
    expect(at(result, 'design')).toMatchObject({ material: 'A36M', specificGravity: 1, designLiquidLevelMm: 12000 });
  });
});

describe('equipment_datasheet converts to millimetres whatever the document unit', () => {
  it('gives the same lengths for the separator built in metres', () => {
    const metres = apply(
      apply(apply({ ...mmDocument() }, 'set_units', { units: 'm' }), 'add_vessel', {
        ...separatorParams,
        location: [5, 5],
        insideDiameter: 1.5,
        tangentLength: 4,
        shellThickness: 0.01,
        headThickness: 0.01,
        corrosionAllowance: 0.003,
        support: { type: 'skirt', height: 2, thickness: 0.01 },
        design: { ...separatorParams.design, operatingLiquid: { specificGravity: 0.85, levelAboveBottomTangent: 1.5 } },
      }),
      'add_nozzle',
      { equipment: 'V-101', ...separatorNozzles[0], location: { on: 'shell', elevation: 3.2, orientationDeg: 0 }, projection: 1 },
    );
    const result = sheet(metres, 'V-101');
    expect(at(result, 'provenance.documentUnits')).toBe('m');
    expect(at(result, 'geometry')).toMatchObject({
      insideDiameterMm: 1500,
      tangentLengthMm: 4000,
      shellThicknessMm: 10,
      support: { heightMm: 2000 },
    });
    expect(at(result, 'identification.locationMm')).toEqual([5000, 5000]);
    expect(at(result, 'volumes.totalVolumeM3')).toBeCloseTo(7.9521564043991635, 9);
    expect(at(result, 'volumes.insideHeightMm')).toBeCloseTo(4750, 6);
    expect(rowsAt(result, 'nozzles')[0]).toMatchObject({ projectionMm: 1000, positionMm: [5000, 6000, 5200] });
    expect(at(result, 'geometry.insideSurfaceAreaM2')).toBeCloseTo(23.727489942, 8);
  });
});

describe('equipment_datasheet CSV', () => {
  const doc = separatorDocument();

  it('items: one row per value with section, dotted item, value, unit and source', () => {
    const result = sheet(doc, 'V-101', { format: 'csv' });
    const rows = csvRows(textAt(result, 'text'));
    expect(rows[0]).toEqual(['section', 'item', 'value', 'unit', 'source']);
    expect(rows).toContainEqual(['design', 'allowableStress', '137.9', 'MPa', 'user input']);
    expect(rows).toContainEqual(['geometry', 'insideDiameterMm', '1500', 'mm', '']);
    expect(rows).toContainEqual(['geometry', 'boundingBoxMm.2', '6385', 'mm', '']);
    const empty = rows.find((row) => row[1] === 'weights' || row[1] === 'body.emptyKg');
    expect(empty?.[3]).toBe('kg');
    expect(rows.find((row) => row[0] === 'volumes' && row[1] === 'headDepthsMm.first')?.[3]).toBe('mm');
    expect(at(result, 'fileName')).toBe('V-101-datasheet.csv');
    expect(at(result, 'table')).toBe('items');
  });

  it('units come from anchored key names only: a text value, a count or a name ending in C or M gets none', () => {
    const rows = csvRows(textAt(sheet(doc, 'V-101', { format: 'csv' }), 'text'));
    const unitOf = (section: string, item: string): string | undefined => rows.find((row) => row[0] === section && row[1] === item)?.[3];
    expect(unitOf('design', 'temperatureC')).toBe('degC');
    expect(unitOf('design', 'materialDensityKgM3')).toBe('kg/m3');
    expect(unitOf('volumes', 'totalVolumeM3')).toBe('m3');
    expect(unitOf('geometry', 'insideSurfaceAreaM2')).toBe('m2');
    expect(unitOf('codeResults', 'thickness.mawpMPa')).toBe('MPa');
    expect(unitOf('codeResults', 'thickness.components.shell.inputs.SE_MPa')).toBe('MPa');
    expect(unitOf('design', 'material')).toBe('');
    expect(unitOf('geometry', 'heads.first.ratio')).toBe('');
    expect(unitOf('identification', 'tag')).toBe('');
    expect(unitOf('identification', 'planRotationDeg')).toBe('deg');
  });

  it('nozzles: one row per nozzle with the position, direction and flange columns', () => {
    const result = sheet(doc, 'V-101', { format: 'csv', table: 'nozzles' });
    const rows = csvRows(textAt(result, 'text'));
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveLength(21);
    expect(rows[1]?.slice(0, 15)).toEqual([
      'N1',
      'V-101:N1',
      'inlet',
      '150',
      'CL150',
      'RF',
      'shell',
      '0',
      '1000',
      '5000',
      '6000',
      '5200',
      '0',
      '1',
      '0',
    ]);
    expect(rows[2]?.slice(12, 15)).toEqual(['0', '0', '-1']);
    expect(at(result, 'fileName')).toBe('V-101-nozzles.csv');
  });

  it('guards text cells that a spreadsheet would read as a formula (= + - @), never the numbers', () => {
    const hostile = apply(
      apply(mmDocument(), 'add_vessel', {
        ...separatorParams,
        name: '=HYPERLINK("http://x")',
        design: { ...separatorParams.design, material: '+cmd|calc' },
      }),
      'add_nozzle',
      { equipment: 'V-101', ...separatorNozzles[0], service: '@SUM(A1)', mark: '-N1' },
    );
    const items = csvRows(textAt(sheet(hostile, 'V-101', { format: 'csv' }), 'text')).flat();
    expect(items).toContain(`'=HYPERLINK("http://x")`.replace(/"/g, '""').replace(/^/, '"').concat('"'));
    expect(items).toContain("'+cmd|calc");
    const nozzles = csvRows(textAt(sheet(hostile, 'V-101', { format: 'csv', table: 'nozzles' }), 'text'));
    expect(nozzles[1]?.slice(0, 3)).toEqual(["'-N1", 'V-101:-N1', "'@SUM(A1)"]);
    expect(nozzles[1]?.[12]).toBe('0');
    expect(nozzles[1]?.[11]).toBe('5200');
  });

  it('keeps hostile object keys harmless: a nozzle mark "__proto__" or "constructor" is only a value', () => {
    let hostile = separatorDocument(false);
    for (const mark of ['__proto__', 'constructor'])
      hostile = apply(hostile, 'add_nozzle', {
        equipment: 'V-101',
        ...separatorNozzles[0],
        mark,
        location: { on: 'shell', elevation: mark === 'constructor' ? 1000 : 3200, orientationDeg: mark === 'constructor' ? 180 : 0 },
      });
    const result = sheet(hostile, 'V-101');
    expect(rowsAt(result, 'nozzles').map((row) => at(row, 'mark'))).toEqual(['__proto__', 'constructor']);
    expect(rowsAt(result, 'nozzles').map((row) => at(row, 'portId'))).toEqual(['V-101:__proto__', 'V-101:constructor']);
    expect(Object.getPrototypeOf(rowsAt(result, 'nozzles')[0])).toBe(Object.prototype);
  });
});

describe('equipment_datasheet refusals', () => {
  const doc = separatorDocument();

  it('unknown equipment is EQP_NOT_FOUND with the equipment path', () => {
    expectRefusal(doc, 'equipment_datasheet', { equipment: 'V-999' }, 'EQP_NOT_FOUND', 'equipment');
  });

  it('legacy footprint equipment and a nozzle-only block are EQP_NOT_PARAMETRIC', () => {
    const legacy = apply(mmDocument(), 'add_equipment', {
      name: 'Skid',
      mark: 'K-1',
      location: [0, 0],
      size: [1000, 1000, 1000],
      weight: 100,
    });
    expectRefusal(legacy, 'equipment_datasheet', { equipment: 'K-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
    const block = apply(legacy, 'add_nozzle', {
      equipment: 'K-1',
      mark: 'N1',
      dn: 100,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 0, 1000], direction: [0, 0, 1] },
      projection: 200,
    });
    const refusal = expectRefusal(block, 'equipment_datasheet', { equipment: 'K-1' }, 'EQP_NOT_PARAMETRIC', 'equipment');
    expect(refusal.summary).toMatch(/block/);
  });

  it('invalid params are rejected before the command runs (unknown format, empty equipment)', () => {
    for (const params of [{ equipment: '' }, { equipment: 'V-101', format: 'xlsx' }, { equipment: 'V-101', table: 'all' }]) {
      const result = execute(doc, 'equipment_datasheet', params);
      expect(result.rejected).toBe(true);
      expect(result.document).toBe(doc);
    }
  });
});
