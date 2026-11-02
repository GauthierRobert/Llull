/**
 * Plant 03 EQP M4: TEMA parsing (VC-EQP-11), `add_heat_exchanger`, its nozzles, volumes (VC-EQP-15 numbers also run through the SC-EQP-03 plan), masses and
 * checks. Reference values are re-derived in the tests from the closed forms of the validation pack; none comes from running llull.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { parseTema } from '@aec/plant/equipment/codecheck/tema';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { bemDocument, bemNozzles, bemParams, mmDocument } from './equipmentFixtures';

const TEMA_FILE = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation/data/tema_designations.json');
const equipmentOf = (doc: CadDocument, tag: string): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

describe('VC-EQP-11: TEMA designation parser', () => {
  const cases = (JSON.parse(readFileSync(TEMA_FILE, 'utf8')) as { designation: { cases: Array<Record<string, unknown>> } }).designation
    .cases;

  it.each(cases.filter((entry) => entry['error'] === undefined))('$input parses to the published letters and flags', (entry) => {
    const parsed = parseTema(entry['input'] as string);
    if ('code' in parsed) throw new Error(parsed.message);
    expect(parsed.tema).toEqual({
      front: entry['front'],
      shell: entry['shell'],
      rear: entry['rear'],
      fixedTubesheet: entry['fixedTubesheet'],
      removableBundle: entry['removableBundle'],
    });
  });

  it.each(cases.filter((entry) => entry['error'] !== undefined))('$input is refused with its code and path', (entry) => {
    const parsed = parseTema(entry['input'] as string);
    expect(parsed).toMatchObject({ code: entry['error'], path: (entry['paths'] as string[])[0] });
  });

  it('AKT is a valid designation that is not modelled: the shell letter K is reported EQP_TEMA_UNSUPPORTED at index 1', () => {
    const parsed = parseTema('AKT');
    expect('tema' in parsed && parsed.unsupported).toMatchObject({ code: 'EQP_TEMA_UNSUPPORTED', path: 'temaType.1' });
  });

  it('is case-insensitive and rejects non-letters and wrong lengths', () => {
    expect('tema' in parseTema(' bem ')).toBe(true);
    for (const text of ['', 'BE', 'BEMX', 'B1M', 'B M'])
      expect(parseTema(text), text).toMatchObject({ code: 'EQP_TEMA_INVALID', path: 'temaType' });
    expect(parseTema('DEM')).toMatchObject({ tema: { front: 'D' }, unsupported: { code: 'EQP_TEMA_UNSUPPORTED', path: 'temaType.0' } });
  });
});

describe('add_heat_exchanger: BEM (SC-EQP-03)', () => {
  const doc = apply(mmDocument(), 'add_heat_exchanger', bemParams);
  const element = equipmentOf(doc, 'E-301');

  it('creates one equipment element with the plant template and derived solids tagged to it', () => {
    const result = ok(mmDocument(), 'add_heat_exchanger', bemParams);
    expect(result.affected).toContain(element.id);
    expect(result.affected).toHaveLength(10);
    expect(element.plant?.template.kind).toBe('exchanger');
    const parts = Object.keys(doc.entities).map((id) => id.replace(`${element.id}:`, ''));
    expect(parts).toEqual([
      'shell',
      'front-tubesheet',
      'front-channel',
      'front-bonnet',
      'rear-tubesheet',
      'rear-channel',
      'rear-bonnet',
      'saddle-1',
      'saddle-2',
    ]);
    expect(doc.order.filter((id) => id.startsWith(`${element.id}:`))).toHaveLength(parts.length);
    const report = result.data as Record<string, unknown>;
    expect(report['tema']).toEqual({ front: 'B', shell: 'E', rear: 'M', fixedTubesheet: true, removableBundle: false });
    expect(report['bundlePullLength']).toBeNull();
    expect(report['shellLength']).toBe(4777);
    expect(report['insideOverallLength']).toBe(5777);
  });

  it('derives the legacy fields: raised on saddles -> box of the outside length x diameter x axis + radius, weight = empty (no fluid gravity)', () => {
    // outside overall length = inside overall length 5777 + 2 x bonnet wall 8 (the offset of a 2:1 head moves its apex out by t)
    expect(element.size[1]).toBe(616);
    expect(element.size[2]).toBe(1308);
    expect(element.size[0]).toBeCloseTo(5777 + 2 * 8, 6);
    expect(element.shape).toBeUndefined();
    const weights = data<{ body: { emptyKg: number } }>(doc, 'equipment_weights', { equipment: 'E-301' });
    expect(element.weight).toBe(weights.body.emptyKg);
  });

  it('centres the frame on the outside overall length: front and rear bonnet apexes are symmetric about the location', () => {
    const body = (id: string): { position: number[]; profile: number[][] } => doc.entities[`${element.id}:${id}`] as never;
    const front = Math.min(...body('front-bonnet').profile.map((point) => point[1] as number));
    const rear = Math.max(...body('rear-bonnet').profile.map((point) => point[1] as number));
    expect(front + rear).toBeCloseTo(0, 9);
    expect(rear - front).toBeCloseTo(element.size[0], 9);
  });

  it('records the defaults it applied and the BWG-free tube wall', () => {
    const report = data<{ defaulted: string[]; tubeWall: { unverified: boolean } }>(mmDocument(), 'add_heat_exchanger', bemParams);
    expect(report.defaulted).toEqual(expect.arrayContaining(['corrosionAllowance', 'frontChannel.thickness', 'rearChannel.thickness']));
    expect(report.tubeWall.unverified).toBe(false);
  });

  it('is pure and replays to the same ids', () => {
    const before = mmDocument();
    const snapshot = JSON.stringify(before);
    execute(before, 'add_heat_exchanger', bemParams);
    expect(JSON.stringify(before)).toBe(snapshot);
    const again = apply(mmDocument(), 'add_heat_exchanger', bemParams);
    expect(Object.keys(again.entities)).toEqual(Object.keys(doc.entities));
    expect(again.featureHistory.map((step) => step.name)).toEqual(['set_units', 'add_heat_exchanger']);
  });
});

describe('add_heat_exchanger: other TEMA types', () => {
  const aes = { ...bemParams, tag: 'E-302', temaType: 'AES', rearChannel: undefined };
  const aeu = { ...aes, tag: 'E-303', temaType: 'aeu' };

  it('AES / AEU: removable bundle, flat front cover, shell cover at the rear, bundle pull = tube length + 1 m', () => {
    const report = data<{ tema: Record<string, unknown>; bundlePullLength: number; insideOverallLength: number; shellLength: number }>(
      mmDocument(),
      'add_heat_exchanger',
      aes,
    );
    expect(report.tema).toEqual({ front: 'A', shell: 'E', rear: 'S', fixedTubesheet: false, removableBundle: true });
    expect(report.bundlePullLength).toBe(4877 + 1000);
    expect(report.shellLength).toBe(4877 - 50);
    // inside: front cover face (flat) + channel 300 + tubesheet 50 + shell 4827 + shell cover 2:1 depth 150
    expect(report.insideOverallLength).toBe(300 + 50 + 4827 + 150);
    const doc = apply(mmDocument(), 'add_heat_exchanger', aeu);
    expect(equipmentOf(doc, 'E-303').plant?.template).toMatchObject({ temaType: 'AEU', tema: { rear: 'U', removableBundle: true } });
    const parts = Object.keys(doc.entities).map((id) => id.split(':')[1]);
    expect(parts).toEqual(['shell', 'front-tubesheet', 'front-channel', 'front-cover', 'rear-shell-cover', 'saddle-1', 'saddle-2']);
  });

  it('shell side of a shell-cover rear adds the 2:1 cover volume pi D^3 / 24; tube side has no rear channel', () => {
    const report = data<{ shellSide: { volumeM3: number }; tubeSide: { volumeM3: number } }>(
      apply(mmDocument(), 'add_heat_exchanger', aes),
      'vessel_volume',
      { equipment: 'E-302' },
    );
    const area = Math.PI * 0.3 ** 2;
    const tubes = (300 * Math.PI * 0.01905 ** 2) / 4;
    expect(rel(report.shellSide.volumeM3, (area - tubes) * 4.827 + (Math.PI * 0.6 ** 3) / 24)).toBeLessThan(1e-9);
    const bore = 0.01905 - 2 * 0.001651;
    expect(rel(report.tubeSide.volumeM3, (300 * Math.PI * bore ** 2 * 4.877) / 4 + area * 0.3)).toBeLessThan(1e-9);
  });

  it('a frontChannel and a bonnet-less front A / C / N share the flat cover; B is a bonnet', () => {
    const c = apply(mmDocument(), 'add_heat_exchanger', { ...aes, tag: 'E-304', temaType: 'CFP' });
    expect(Object.keys(c.entities).some((id) => id.endsWith('front-cover'))).toBe(true);
    expect(equipmentOf(c, 'E-304').plant?.template).toMatchObject({ tema: { shell: 'F', rear: 'P' } });
  });
});

describe('add_heat_exchanger: refusals leave the document unchanged and name the path', () => {
  const doc = mmDocument();
  it.each([
    ['EQP_TEMA_INVALID', { temaType: 'BXZ' }, 'temaType.2'],
    ['EQP_TEMA_INVALID', { temaType: 'BE' }, 'temaType'],
    ['EQP_TEMA_UNSUPPORTED', { temaType: 'AKT' }, 'temaType.1'],
    ['EQP_TEMA_UNSUPPORTED', { temaType: 'DEM' }, 'temaType.0'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, bwg: 16 } }, 'tubes.bwg'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, wallThickness: undefined } }, 'tubes.wallThickness'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, wallThickness: 9.6 } }, 'tubes.wallThickness'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, pitch: 19 } }, 'tubes.pitch'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, count: 600 } }, 'tubes.count'],
    ['EQP_PARAM_INVALID', { tubes: { ...bemParams.tubes, length: 90 } }, 'tubes.length'],
    ['EQP_PARAM_INVALID', { corrosionAllowance: 8 }, 'shellThickness'],
    ['EQP_PARAM_INVALID', { corrosionAllowance: 3, frontChannel: { length: 300, thickness: 3 } }, 'frontChannel.thickness'],
    ['EQP_PARAM_INVALID', { corrosionAllowance: 3, rearChannel: { length: 300, thickness: 2 } }, 'rearChannel.thickness'],
    ['EQP_PARAM_INVALID', { temaType: 'AES' }, 'rearChannel'],
    ['EQP_PARAM_INVALID', { location: [1] }, 'location'],
    ['EQP_PARAM_INVALID', { tag: 'E 1' }, 'tag'],
    ['EQP_PARAM_INVALID', { levelId: 'nope' }, 'levelId'],
    ['EQP_SUPPORT_INVALID', { support: { type: 'skirt', height: 500 } }, 'support.type'],
    ['EQP_SUPPORT_INVALID', { support: { type: 'saddles', stations: [5000], width: 200, axisElevation: 1000 } }, 'support.stations.0'],
    ['EQP_SUPPORT_INVALID', { support: { type: 'saddles', stations: [800], width: 200, axisElevation: 300 } }, 'support.axisElevation'],
  ])('%s %j', (code, change, at) => {
    expectRefusal(doc, 'add_heat_exchanger', { ...bemParams, ...change }, code, at);
  });

  it('a duplicate tag is EQP_TAG_DUPLICATE with the existing id', () => {
    const result = expectRefusal(bemDocument(false), 'add_heat_exchanger', bemParams, 'EQP_TAG_DUPLICATE', 'tag');
    expect(result.error?.ids).toEqual(['equipment-1']);
  });

  it('a call with an invalid TEMA type and missing required fields is rejected by the schema first (CMD_INVALID_PARAMS)', () => {
    const result = execute(doc, 'add_heat_exchanger', { tag: 'E-9', temaType: 'BXZ', location: [0, 0] });
    expect(result.rejected).toBe(true);
    expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('a BWG wall comes from the grade B table and is reported unverified', () => {
    const { wallThickness: _wall, ...tubes } = bemParams.tubes;
    const report = data<{ tubeWall: { value: number; unverified: boolean; source: string } }>(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      tubes: { ...tubes, bwg: 16 },
    });
    expect(report.tubeWall).toMatchObject({ value: 1.651, unverified: true });
    expect(report.tubeWall.source).toContain('BWG 16');
    expectRefusal(
      mmDocument(),
      'add_heat_exchanger',
      { ...bemParams, tubes: { ...tubes, bwg: 16, outsideDiameter: 20 } },
      'EQP_PARAM_INVALID',
      'tubes.bwg',
    );
  });
});

describe('exchanger nozzles', () => {
  const doc = bemDocument();

  it('shell stations count from the front end of the shell; channel stations from the tubesheet face (VC-EQP-12 style closed forms)', () => {
    const ports = data<{ ports: Record<string, { position: number[]; direction: number[] }> }>(doc, 'equipment_ports', {
      equipment: 'E-301',
    }).ports;
    // shell inlet at station 400 from the front shell end; the outside overall length is symmetric, so the shell starts at -4777 / 2
    expect(ports['E-301:S1']?.position[0]).toBeCloseTo(-4777 / 2 + 400, 6);
    expect(ports['E-301:S2']?.position[0]).toBeCloseTo(-4777 / 2 + 4377, 6);
    expect(ports['E-301:S1']?.position[1]).toBeCloseTo(8000, 9);
    expect(ports['E-301:S1']?.position[2]).toBeCloseTo(1000 + 600, 6);
    expect(ports['E-301:S1']?.direction).toEqual([0, 0, 1]);
    expect(ports['E-301:S2']?.direction).toEqual([0, 0, -1]);
    // front channel: from the tubesheet face (shell start - 50) outward 150
    expect(ports['E-301:T1']?.position[0]).toBeCloseTo(-4777 / 2 - 50 - 150, 6);
    expect(ports['E-301:T1']?.position[2]).toBeCloseTo(1000 - 550, 6);
    expect(ports['E-301:T1']?.direction).toEqual([0, 0, -1]);
    expect(ports['E-301:T2']?.direction).toEqual([0, 0, 1]);
  });

  it('a rear channel nozzle sits beyond the rear tubesheet; the nozzle solid is a derived revolution', () => {
    const next = apply(doc, 'add_nozzle', {
      equipment: 'E-301',
      mark: 'R1',
      dn: 50,
      rating: 'CL150',
      location: { on: 'channel', channel: 'rear', station: 100, orientationDeg: 90 },
      projection: 500,
    });
    const ports = data<{ ports: Record<string, { position: number[]; direction: number[] }> }>(next, 'equipment_ports', {
      equipment: 'E-301',
    }).ports;
    expect(ports['E-301:R1']?.position[0]).toBeCloseTo(4777 / 2 + 50 + 100, 6);
    expect(ports['E-301:R1']?.direction).toEqual([0, 1, 0]);
    expect(next.entities[`${equipmentOf(next, 'E-301').id}:nozzle-R1`]?.kind).toBe('revolution');
  });

  it.each([
    ['EQP_NOZZLE_OFF_BODY', { on: 'shell', station: 5000, orientationDeg: 0 }, 600, 'location.station'],
    ['EQP_NOZZLE_OFF_BODY', { on: 'channel', channel: 'front', station: 301, orientationDeg: 0 }, 550, 'location.station'],
    ['EQP_PARAM_INVALID', { on: 'shell', elevation: 100, orientationDeg: 0 }, 600, 'location.station'],
    ['EQP_PARAM_INVALID', { on: 'head', head: 'left', radialOffset: 0 }, 600, 'location.on'],
    ['EQP_NOZZLE_PROJECTION_TOO_SHORT', { on: 'shell', station: 400, orientationDeg: 0 }, 310, 'projection'],
    ['EQP_NOZZLE_PROJECTION_TOO_SHORT', { on: 'channel', channel: 'front', station: 100, orientationDeg: 0 }, 310, 'projection'],
  ])('%s %j', (code, location, projection, at) => {
    expectRefusal(doc, 'add_nozzle', { equipment: 'E-301', mark: 'X1', dn: 100, rating: 'CL150', location, projection }, code, at);
  });

  it('the rear head of a shell-cover exchanger has no channel; a vessel refuses a channel location', () => {
    const aes = apply(mmDocument(), 'add_heat_exchanger', { ...bemParams, temaType: 'AES', rearChannel: undefined });
    expectRefusal(
      aes,
      'add_nozzle',
      {
        equipment: 'E-301',
        mark: 'X1',
        dn: 100,
        rating: 'CL150',
        location: { on: 'channel', channel: 'rear', station: 10, orientationDeg: 0 },
        projection: 550,
      },
      'EQP_PARAM_INVALID',
      'location.channel',
    );
    const vessel = apply(mmDocument(), 'add_vessel', {
      tag: 'V-1',
      orientation: 'horizontal',
      location: [0, 0],
      insideDiameter: 1000,
      tangentLength: 2000,
      heads: { left: { type: 'ellipsoidal', ratio: 2 }, right: { type: 'ellipsoidal', ratio: 2 } },
      shellThickness: 10,
      support: { type: 'none' },
    });
    expectRefusal(
      vessel,
      'add_nozzle',
      {
        equipment: 'V-1',
        mark: 'X1',
        dn: 100,
        rating: 'CL150',
        location: { on: 'channel', channel: 'front', station: 10, orientationDeg: 0 },
        projection: 700,
      },
      'EQP_PARAM_INVALID',
      'location.on',
    );
  });

  it('nozzle marks follow the same rules as on a vessel', () => {
    expectRefusal(doc, 'add_nozzle', { equipment: 'E-301', ...bemNozzles[0], mark: 'S1' }, 'EQP_NOZZLE_MARK_DUPLICATE', 'mark');
  });
});

describe('exchanger masses (equipment_weights)', () => {
  const doc = bemDocument();
  const report = data<{
    body: { emptyKg: number; operatingKg: number; testKg: number };
    nozzles?: { kg: number };
    total: { emptyKg: number };
    breakdown: Array<{ part: string; kg: number }>;
    warnings: Array<{ code: string; paths: string[] }>;
    volumesM3: { shellSide: number; tubeSide: number };
  }>(doc, 'equipment_weights', { equipment: 'E-301', include: ['body', 'nozzles'] });
  const part = (name: string): number => report.breakdown.find((row) => row.part === name)?.kg ?? Number.NaN;
  const rho = 7850e-9;

  it('shell, channel, tubesheet and tube metal match the closed forms', () => {
    expect(rel(part('shell'), Math.PI * (308 ** 2 - 300 ** 2) * 4777 * rho)).toBeLessThan(1e-12);
    expect(rel(part('frontChannel'), Math.PI * (308 ** 2 - 300 ** 2) * 300 * rho)).toBeLessThan(1e-12);
    expect(rel(part('frontTubesheet'), (Math.PI * 308 ** 2 - (300 * Math.PI * 19.05 ** 2) / 4) * 50 * rho)).toBeLessThan(1e-12);
    expect(rel(part('tubes'), (300 * Math.PI * (19.05 ** 2 - (19.05 - 2 * 1.651) ** 2) * 4877 * rho) / 4)).toBeLessThan(1e-12);
  });

  it('body is the sum of the parts, test = empty + both sides full of water, and the element weight is the empty weight', () => {
    const sum = report.breakdown.filter((row) => !row.part.startsWith('nozzle')).reduce((total, row) => total + row.kg, 0);
    expect(rel(report.body.emptyKg, sum)).toBeLessThan(1e-12);
    expect(rel(report.body.testKg, report.body.emptyKg + (0.9421985298921338 + 0.5111748822078709) * 1000)).toBeLessThan(1e-9);
    expect(report.total.emptyKg).toBeCloseTo(report.body.emptyKg + (report.nozzles?.kg ?? 0), 9);
    expect(equipmentOf(doc, 'E-301').weight).toBe(report.body.operatingKg);
  });

  it('a side without specific gravity adds nothing and says so; with it the operating weight includes the fluid', () => {
    expect(report.warnings.map((warning) => warning.paths[0])).toEqual([
      'design.shellSide.specificGravity',
      'design.tubeSide.specificGravity',
    ]);
    const fluid = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      design: { shellSide: { specificGravity: 0.8 }, tubeSide: { specificGravity: 1 } },
    });
    const weights = data<{ body: { emptyKg: number; operatingKg: number }; warnings: unknown[] }>(fluid, 'equipment_weights', {
      equipment: 'E-301',
    });
    expect(rel(weights.body.operatingKg, weights.body.emptyKg + (0.9421985298921338 * 0.8 + 0.5111748822078709) * 1000)).toBeLessThan(1e-9);
    expect(weights.warnings).toEqual([]);
    expect(equipmentOf(fluid, 'E-301').weight).toBe(weights.body.operatingKg);
  });
});

describe('check_equipment on an exchanger', () => {
  const rated = (shell: number, channel: number, extra: object = {}): CadDocument =>
    apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      shellThickness: shell,
      frontChannel: { length: 300, thickness: channel },
      rearChannel: { length: 300, thickness: channel },
      design: {
        shellSide: {
          pressure: { value: 1, unit: 'MPa' },
          allowableStress: { value: 137.9, unit: 'MPa', source: 'datasheet' },
          jointEfficiency: { shell: 1, heads: 1 },
        },
        tubeSide: {
          pressure: { value: 0.6, unit: 'MPa' },
          allowableStress: { value: 137.9, unit: 'MPa', source: 'datasheet' },
          jointEfficiency: { shell: 1, heads: 1 },
        },
      },
      ...extra,
    });
  type Check = {
    status: string;
    issues: Array<{ code: string; severity: string; paths: string[]; message: string }>;
    reviewRequired: boolean;
  };

  it('an adequate exchanger with design data is pass_with_review: nothing failed, review required, what is not covered is named', () => {
    const report = data<Check & { checked: Array<{ notChecked: string[] }> }>(rated(8, 8), 'check_equipment', {});
    expect(report.issues).toEqual([]);
    expect(report.status).toBe('pass_with_review');
    expect(report.reviewRequired).toBe(true);
    expect(report.checked[0]?.notChecked.join(' ')).toContain('tubesheet');
  });

  it('shell t_req = P R / (S E - 0.6 P) = 2.1855 mm: a 2 mm shell fails EQP_SHELL_UNDER_THICKNESS at shellThickness, a 2.2 mm one passes', () => {
    const thin = data<Check>(rated(2, 8), 'check_equipment', {});
    const fail = thin.issues.find((issue) => issue.code === 'EQP_SHELL_UNDER_THICKNESS');
    expect(fail).toMatchObject({ severity: 'fail', paths: ['shellThickness'] });
    expect(fail?.message).toContain('2.18');
    expect(thin.status).toBe('fail');
    expect(data<Check>(rated(2.2, 8), 'check_equipment', {}).issues.some((issue) => issue.severity === 'fail')).toBe(false);
  });

  it('channels and bonnets are judged against the tube side: a 1 mm channel fails at frontChannel.thickness (and the bonnet at the same path)', () => {
    const thin = data<Check>(rated(8, 1), 'check_equipment', {});
    const fails = thin.issues.filter((issue) => issue.severity === 'fail');
    expect(fails.map((issue) => issue.code)).toEqual(expect.arrayContaining(['EQP_SHELL_UNDER_THICKNESS', 'EQP_HEAD_UNDER_THICKNESS']));
    expect(new Set(fails.flatMap((issue) => issue.paths))).toEqual(new Set(['frontChannel.thickness', 'rearChannel.thickness']));
  });

  it('a pressure above 0.385 S E refuses only that side as EQP_FORMULA_OUT_OF_RANGE; the other side is still judged', () => {
    const report = data<Check>(
      rated(8, 8, {
        design: {
          shellSide: {
            pressure: { value: 60, unit: 'MPa' },
            allowableStress: { value: 137.9, unit: 'MPa', source: 'x' },
            jointEfficiency: { shell: 1, heads: 1 },
          },
          tubeSide: {
            pressure: { value: 0.6, unit: 'MPa' },
            allowableStress: { value: 137.9, unit: 'MPa', source: 'x' },
            jointEfficiency: { shell: 1, heads: 1 },
          },
        },
      }),
      'check_equipment',
      {},
    );
    expect(report.issues.map((issue) => [issue.code, issue.severity])).toContainEqual(['EQP_FORMULA_OUT_OF_RANGE', 'warning']);
    expect(report.status).toBe('warn');
  });

  it('a flat cover is not covered by the formulas (warning EQP_HEAD_NOT_COVERED at the channel), a stress without source is flagged', () => {
    const aes = apply(mmDocument(), 'add_heat_exchanger', {
      ...bemParams,
      temaType: 'AEL',
      design: {
        shellSide: {
          pressure: { value: 1, unit: 'MPa' },
          allowableStress: { value: 137.9, unit: 'MPa' },
          jointEfficiency: { shell: 1, heads: 1 },
        },
        tubeSide: {
          pressure: { value: 0.6, unit: 'MPa' },
          allowableStress: { value: 137.9, unit: 'MPa', source: 's' },
          jointEfficiency: { shell: 1, heads: 1 },
        },
      },
    });
    const report = data<Check>(aes, 'check_equipment', {});
    const codes = report.issues.map((issue) => `${issue.code}@${issue.paths[0]}`);
    expect(codes).toContain('EQP_HEAD_NOT_COVERED@frontChannel.thickness');
    expect(codes).toContain('EQP_VALUE_UNSOURCED@design.shellSide.allowableStress.source');
  });

  it('missing side design is a warning of that side, never a pass; a BWG tube wall is EQP_TABLE_UNVERIFIED', () => {
    const { wallThickness: _wall, ...tubes } = bemParams.tubes;
    const bare = apply(mmDocument(), 'add_heat_exchanger', { ...bemParams, design: undefined, tubes: { ...tubes, bwg: 16 } });
    const report = data<Check>(bare, 'check_equipment', { equipment: ['E-301'] });
    const codes = report.issues.map((issue) => `${issue.code}@${issue.paths[0]}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'EQP_DESIGN_DATA_MISSING@design.shellSide',
        'EQP_DESIGN_DATA_MISSING@design.tubeSide',
        'EQP_TABLE_UNVERIFIED@tubes.wallThickness',
      ]),
    );
    expect(report.status).toBe('warn');
  });
});

describe('exchangers keep the generic equipment commands honest', () => {
  const doc = bemDocument();
  it('update_equipment_parameters and update_equipment refuse a parametric exchanger with a coded reason', () => {
    const result = expectRefusal(
      doc,
      'update_equipment_parameters',
      { equipment: 'E-301', set: { name: 'x' } },
      'EQP_NOT_PARAMETRIC',
      'equipment',
    );
    expect(result.summary).toContain('parametric exchanger');
    expectRefusal(doc, 'update_equipment', { currentMark: 'E-301', name: 'x' }, 'EQP_NOT_PARAMETRIC', 'elementId');
  });

  it('vessel_volume refuses levels, an inline geometry next to equipment and side on a vessel; side selects totalVolumeM3', () => {
    expectRefusal(doc, 'vessel_volume', { equipment: 'E-301', levels: [100] }, 'EQP_PARAM_INVALID', 'levels');
    expectRefusal(doc, 'vessel_volume', { equipment: 'E-301', orientation: 'vertical' }, 'EQP_PARAM_INVALID', 'orientation');
    const tube = data<{ totalVolumeM3: number; side: string }>(doc, 'vessel_volume', { equipment: 'E-301', side: 'tube' });
    expect(tube.side).toBe('tube');
    expect(rel(tube.totalVolumeM3, 0.5111748822078709)).toBeLessThan(1e-9);
    expect(data<{ side?: string }>(doc, 'vessel_volume', { equipment: 'E-301' }).side).toBeUndefined();
    const vessel = apply(mmDocument(), 'add_vessel', {
      tag: 'V-1',
      orientation: 'vertical',
      location: [0, 0],
      insideDiameter: 1000,
      tangentLength: 2000,
      heads: { top: { type: 'ellipsoidal', ratio: 2 }, bottom: { type: 'ellipsoidal', ratio: 2 } },
      shellThickness: 10,
      support: { type: 'none' },
    });
    expectRefusal(vessel, 'vessel_volume', { equipment: 'V-1', side: 'shell' }, 'EQP_PARAM_INVALID', 'side');
  });

  it('the plant record survives a save / load round trip and the derived solids are re-derived identically', async () => {
    const { deserializeDocument, serializeDocument } = await import('@core/commands/persistence/serialization');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(equipmentOf(loaded, 'E-301').plant).toEqual(equipmentOf(doc, 'E-301').plant);
    expect(Object.keys(loaded.entities)).toEqual(Object.keys(doc.entities));
  });
});
