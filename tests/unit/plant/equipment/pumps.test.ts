/**
 * Plant 03 EQP M4: `add_pump` from the shipped ISO 2858 / ASME B73.1 rows or vendor dimensions (VC-EQP-10), its ports, envelope solids, weights and checks.
 * Row values are read from validation/data/pump_envelopes.json; positions are re-derived here from the envelope meaning of TECHNICAL_SPEC §5.8.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { BoxEntity, CadDocument } from '@core/model/types';
import type { EquipmentElement } from '@aec/building/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { mmDocument, pumpDocument, pumpParams } from './equipmentFixtures';

const FILE = path.resolve(__dirname, '../../../../docs/plant/03-parametric-equipment/validation/data/pump_envelopes.json');
const rows = JSON.parse(readFileSync(FILE, 'utf8')) as {
  iso2858: { rows: Array<{ size: string; a: number | null; f: number | null; h1: number; h2: number; grade: string }> };
  asmeB73_1: { rows: Array<{ designation: string; size: string; CP_in: number; D_in: number; X_in: number }> };
};
const equipmentOf = (doc: CadDocument, tag = 'P-101'): EquipmentElement => {
  const found = Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === tag);
  if (found?.category !== 'equipment') throw new Error(`no equipment ${tag}`);
  return found;
};
type Report = {
  envelope: {
    a: number;
    f: number;
    h1: number;
    h2: number;
    suctionDn: number;
    dischargeDn: number;
    rating: string;
    grade: string;
    source: string;
  };
  unverified: boolean;
  defaulted: string[];
  suctionPortId: string;
  dischargePortId: string;
  designation: string | null;
};
type Ports = { ports: Record<string, { position: number[]; direction: number[]; dn: number; rating: string }> };

describe('VC-EQP-10: ISO 2858 rows', () => {
  const usable = rows.iso2858.rows.filter((row) => row.a !== null && row.f !== null);

  it.each(usable)('$size: envelope numbers are the table row, grade $grade, DN from the designation', (row) => {
    const report = data<Report>(mmDocument(), 'add_pump', { tag: 'P-1', location: [0, 0], standard: 'iso_2858', size: row.size });
    const [suction, discharge] = row.size.split('-').map(Number);
    expect(report.envelope).toMatchObject({
      a: row.a,
      f: row.f,
      h1: row.h1,
      h2: row.h2,
      suctionDn: suction,
      dischargeDn: discharge,
      rating: 'PN16',
      grade: row.grade,
    });
    expect(report.designation).toBe(row.size);
    expect(report.defaulted).toContain('rating');
  });

  it('65-40-250 with a motor: suction and discharge faces are where the envelope puts them (a, h1, h2, baseplate height)', () => {
    const doc = pumpDocument();
    const ports = data<Ports>(doc, 'equipment_ports', { equipment: 'P-101' }).ports;
    // baseplate 150 high (default); machine from -a = -100 to f + gap + driver = 500 + 100 + 600; baseplate (default margin 100) spans -200..1300; centre 550
    const shift = (-200 + 1300) / 2;
    expect(ports['P-101:SUC']?.position).toEqual([2000 - 100 - shift, 3000, 150 + 180]);
    expect(ports['P-101:SUC']?.direction).toEqual([-1, 0, 0]);
    expect(ports['P-101:DIS']?.position).toEqual([2000 - shift, 3000, 150 + 180 + 225]);
    expect(ports['P-101:DIS']?.direction).toEqual([0, 0, 1]);
    expect(ports['P-101:SUC']).toMatchObject({ dn: 65, rating: 'PN16' });
    expect(ports['P-101:DIS']).toMatchObject({ dn: 40 });
  });

  it('the legacy fields are the bounding box of baseplate, envelope and driver; the weight is the vendor weight', () => {
    const element = equipmentOf(pumpDocument());
    expect(element.size).toEqual([1500, 600, 150 + 180 + 225]);
    expect(element.shape).toBeUndefined();
    expect(element.weight).toBe(310);
  });

  it('creates body, driver and baseplate boxes and two nozzle solids, tagged to the element, sitting on the floor', () => {
    const doc = pumpDocument();
    const element = equipmentOf(doc);
    expect(Object.keys(doc.entities).map((id) => id.split(':')[1])).toEqual([
      'pump-body',
      'driver',
      'baseplate',
      'nozzle-SUC',
      'nozzle-DIS',
    ]);
    const plate = doc.entities[`${element.id}:baseplate`] as BoxEntity;
    expect(plate.size).toEqual([1500, 600, 150]);
    expect(plate.position[2]).toBe(75);
  });

  it('rotates with the plan rotation: 90 degrees clockwise turns the suction direction from -X to +Y', () => {
    const doc = apply(mmDocument(), 'add_pump', { ...pumpParams, planRotationDeg: 90 });
    const ports = data<Ports>(doc, 'equipment_ports', { equipment: 'P-101' }).ports;
    expect(ports['P-101:SUC']?.direction).toEqual([0, 1, 0]);
  });

  it('is pure and replays to the same ids', () => {
    const before = mmDocument();
    const snapshot = JSON.stringify(before);
    execute(before, 'add_pump', pumpParams);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(Object.keys(apply(mmDocument(), 'add_pump', pumpParams).entities)).toEqual(Object.keys(pumpDocument().entities));
  });
});

describe('VC-EQP-10: ASME B73.1 rows are grade B', () => {
  it.each(rows.asmeB73_1.rows)(
    '$designation ($size): CP, D, X converted to the envelope; unverified; the a / f split is a named default',
    (row) => {
      const report = data<Report>(mmDocument(), 'add_pump', {
        tag: 'P-1',
        location: [0, 0],
        standard: 'asme_b73_1',
        size: row.designation,
      });
      expect(report.envelope.h1).toBeCloseTo(row.D_in * 25.4, 9);
      expect(report.envelope.h2).toBeCloseTo(row.X_in * 25.4, 9);
      expect(report.envelope.a + report.envelope.f).toBeCloseTo(row.CP_in * 25.4, 9);
      expect(report.envelope.rating).toBe('CL150');
      expect(report.envelope.grade).toBe('B');
      expect(report.unverified).toBe(true);
      expect(report.defaulted.join(' ')).toContain('envelope.a/f split');
    },
  );

  it('the size text finds the same row; suction and discharge DN come from the inch sizes (1.5 in -> DN40, 1 in -> DN25)', () => {
    const report = data<Report>(mmDocument(), 'add_pump', { tag: 'P-1', location: [0, 0], standard: 'asme_b73_1', size: '1.5x1-6' });
    expect(report.envelope).toMatchObject({ suctionDn: 40, dischargeDn: 25 });
    expect(report.designation).toBe('AA');
  });

  it('check_equipment warns EQP_TABLE_UNVERIFIED on the envelope of a B73.1 pump but not on an ISO grade A row', () => {
    const codes = (standard: string, size: string): string[] =>
      data<{ issues: Array<{ code: string; paths: string[] }> }>(
        apply(mmDocument(), 'add_pump', {
          tag: 'P-1',
          location: [0, 0],
          standard,
          size,
          weightKg: 100,
          driver: { length: 500, width: 300, height: 300 },
        }),
        'check_equipment',
        {},
      )
        .issues.filter((issue) => issue.paths[0] === 'envelope')
        .map((issue) => issue.code);
    expect(codes('asme_b73_1', 'AA')).toEqual(['EQP_TABLE_UNVERIFIED']);
    expect(codes('iso_2858', '65-40-250')).toEqual([]);
  });
});

describe('add_pump: vendor envelope and refusals', () => {
  const vendor = {
    tag: 'P-9',
    location: [0, 0],
    standard: 'custom',
    rating: 'CL300',
    envelope: { a: 120, f: 450, h1: 200, h2: 250, suctionDn: 100, dischargeDn: 80 },
    baseplate: { length: 1200, width: 500, height: 120 },
  };

  it('a custom pump takes the user dimensions as they are; without a source the envelope is grade B, "user input" and flagged EQP_VALUE_UNSOURCED', () => {
    const result = ok(mmDocument(), 'add_pump', vendor);
    const report = result.data as Report;
    expect(report.envelope).toMatchObject({ a: 120, f: 450, h1: 200, h2: 250, rating: 'CL300', grade: 'B', source: 'user input' });
    expect(report.defaulted).toEqual(expect.arrayContaining(['envelope.source', 'driver']));
    expect(report.defaulted).not.toContain('baseplate');
    expect(equipmentOf(result.document, 'P-9').size[0]).toBe(1200);
  });

  it('a sourced vendor envelope is grade A and not flagged; an unsourced one is grade B, unverified and warned at envelope.source', () => {
    const sourced = { ...vendor, envelope: { ...vendor.envelope, source: 'datasheet 12' } };
    const codes = (params: object): string[] =>
      data<{ issues: Array<{ code: string; paths: string[] }> }>(apply(mmDocument(), 'add_pump', params), 'check_equipment', {})
        .issues.filter((issue) => issue.paths[0]?.startsWith('envelope'))
        .map((issue) => `${issue.code}@${issue.paths[0]}`);
    expect(data<Report>(mmDocument(), 'add_pump', sourced)).toMatchObject({
      unverified: expect.any(Boolean),
      envelope: { grade: 'A', source: 'datasheet 12' },
    });
    expect(codes(sourced)).toEqual([]);
    expect(data<Report>(mmDocument(), 'add_pump', vendor).unverified).toBe(true);
    expect(codes(vendor)).toEqual(['EQP_VALUE_UNSOURCED@envelope.source']);
  });

  it('a pump with nothing else to warn about is pass_with_review, never plain pass', () => {
    const doc = apply(mmDocument(), 'add_pump', {
      ...vendor,
      envelope: { ...vendor.envelope, source: 'datasheet 12' },
      driver: { length: 500, width: 300, height: 300 },
      weightKg: 200,
    });
    const report = data<{ status: string; reviewRequired: boolean; reviewReason: string; issues: Array<{ code: string }> }>(
      doc,
      'check_equipment',
      {},
    );
    expect(
      report.issues.map((issue) => issue.code).filter((code) => code !== 'EQP_FLANGE_PLACEHOLDER' && code !== 'EQP_TABLE_UNVERIFIED'),
    ).toEqual([]);
    expect(report.reviewRequired).toBe(true);
    expect(report.reviewReason).toContain('nozzle loads');
  });

  it('an ISO pump with vendor dimensions keeps the standard label and the rating default', () => {
    const report = data<Report>(mmDocument(), 'add_pump', {
      ...vendor,
      standard: 'iso_2858',
      rating: undefined,
      envelope: { ...vendor.envelope, source: 'datasheet 12' },
    });
    expect(report.envelope).toMatchObject({ rating: 'PN16', source: 'datasheet 12' });
  });

  it.each([
    ['EQP_PUMP_SIZE_UNKNOWN', { standard: 'iso_2858', size: '125-100-315', envelope: undefined }, 'size'],
    ['EQP_PUMP_SIZE_UNKNOWN', { standard: 'iso_2858', size: '50-32-125', envelope: undefined }, 'size'],
    ['EQP_PUMP_SIZE_UNKNOWN', { standard: 'iso_2858', size: undefined, envelope: undefined }, 'size'],
    ['EQP_PUMP_SIZE_UNKNOWN', { standard: 'asme_b73_1', size: 'ZZ', envelope: undefined }, 'size'],
    ['EQP_PARAM_INVALID', { standard: 'iso_2858', size: '65-40-250' }, 'envelope'],
    ['EQP_PARAM_INVALID', { rating: undefined }, 'rating'],
    ['EQP_RATING_UNKNOWN', { rating: 'CL1234' }, 'rating'],
    ['EQP_RATING_UNKNOWN', { envelope: { ...vendor.envelope, suctionDn: 7 } }, 'envelope.suctionDn'],
    ['EQP_NOZZLE_PROJECTION_TOO_SHORT', { envelope: { ...vendor.envelope, h2: 5 } }, 'envelope'],
    ['EQP_PARAM_INVALID', { location: [0] }, 'location'],
    ['EQP_PARAM_INVALID', { tag: 'P 1' }, 'tag'],
  ])('%s %j', (code, change, at) => {
    expectRefusal(mmDocument(), 'add_pump', { ...vendor, ...change }, code, at);
  });

  it('a custom pump with a size and no envelope is EQP_PARAM_INVALID (path envelope); a duplicate tag is EQP_TAG_DUPLICATE; a bad API 610 type is a schema error', () => {
    expectRefusal(mmDocument(), 'add_pump', { ...vendor, envelope: undefined, size: 'X' }, 'EQP_PARAM_INVALID', 'envelope');
    expectRefusal(pumpDocument(), 'add_pump', pumpParams, 'EQP_TAG_DUPLICATE', 'tag');
    const bad = execute(mmDocument(), 'add_pump', { ...pumpParams, api610Type: 'XX9' });
    expect(bad.error?.code).toBe('CMD_INVALID_PARAMS');
  });
});

describe('pump weights and checks', () => {
  it('equipment_weights reports the vendor weight as the body; without it the query is refused EQP_DESIGN_DATA_MISSING at weightKg', () => {
    const weights = data<{ body: { emptyKg: number; operatingKg: number }; unverified: boolean }>(pumpDocument(), 'equipment_weights', {
      equipment: 'P-101',
    });
    expect(weights.body).toMatchObject({ emptyKg: 310, operatingKg: 310 });
    const { weightKg: _weight, ...bare } = pumpParams;
    expectRefusal(
      apply(mmDocument(), 'add_pump', bare),
      'equipment_weights',
      { equipment: 'P-101' },
      'EQP_DESIGN_DATA_MISSING',
      'weightKg',
    );
  });

  it('nozzle masses add on request', () => {
    const weights = data<{ nozzles: { kg: number }; total: { emptyKg: number }; body: { emptyKg: number } }>(
      pumpDocument(),
      'equipment_weights',
      { equipment: 'P-101', include: ['body', 'nozzles'] },
    );
    expect(weights.nozzles.kg).toBeGreaterThan(0);
    expect(weights.total.emptyKg).toBeCloseTo(310 + weights.nozzles.kg, 9);
  });

  it('check_equipment: defaulted driver / baseplate and a missing weight are warnings (never a pass); hydraulics, casing rating and nozzle loads are not judged, so reviewRequired is true', () => {
    const { driver: _driver, weightKg: _weight, ...bare } = pumpParams;
    const report = data<{
      status: string;
      reviewRequired: boolean;
      issues: Array<{ code: string; paths: string[] }>;
      checked: Array<{ notChecked: string[] }>;
    }>(apply(mmDocument(), 'add_pump', bare), 'check_equipment', { equipment: ['P-101'] });
    const found = report.issues.map((issue) => `${issue.code}@${issue.paths[0]}`);
    expect(found).toEqual(
      expect.arrayContaining(['EQP_DESIGN_DATA_MISSING@driver', 'EQP_DESIGN_DATA_MISSING@baseplate', 'EQP_DESIGN_DATA_MISSING@weightKg']),
    );
    expect(report.status).toBe('warn');
    expect(report.reviewRequired).toBe(true);
    expect(report.checked[0]?.notChecked.join(' ')).toContain('NPSH');
  });

  it('the plant record survives a save / load round trip', async () => {
    const doc = pumpDocument();
    const { deserializeDocument, serializeDocument } = await import('@core/commands/persistence/serialization');
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(equipmentOf(loaded).plant).toEqual(equipmentOf(doc).plant);
    expect(Object.keys(loaded.entities)).toEqual(Object.keys(doc.entities));
  });

  it('an extra nozzle goes on a pump as a free location only', () => {
    const doc = pumpDocument();
    expectRefusal(
      doc,
      'add_nozzle',
      { equipment: 'P-101', mark: 'V1', dn: 25, rating: 'PN16', location: { on: 'shell', station: 1, orientationDeg: 0 }, projection: 200 },
      'EQP_PARAM_INVALID',
      'location.on',
    );
    const next = apply(doc, 'add_nozzle', {
      equipment: 'P-101',
      mark: 'V1',
      dn: 25,
      rating: 'PN16',
      location: { on: 'free', position: [0, 0, 400], direction: [0, 0, 1] },
      projection: 100,
    });
    expect(equipmentOf(next).plant?.nozzles.map((nozzle) => nozzle.mark)).toEqual(['SUC', 'DIS', 'V1']);
  });
});
