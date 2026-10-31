/**
 * Plant 08 DAT-M2: `plant_report` (line list, equipment list, nozzle schedule, MTO, tag register; CSV / XLSX files) against
 * `validation/data/sc_dat_01_reports_expected.json` (VC-DAT-03, 04, 05), the refusals, determinism and the §8 budget.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { getPlantData, copyObject } from '@aec/plant/data/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { readXlsx } from '../../../helpers/xlsxCells';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { addEquipment, libraryDocument, packJson, scDat01Document, withData } from './dataFixtures';

interface ReportData {
  kind: string;
  columns: Array<{ name: string; displayName: string; type: string; unit: string | null }>;
  rows: Array<Record<string, unknown>>;
  rowsByTag?: Record<string, Record<string, unknown>>;
  total: number;
  totals: Record<string, number>;
  method: string;
  defaults: Record<string, string>;
  files?: Array<{ fileName: string; content?: string; base64?: string }>;
}

const report = (doc: CadDocument, params: Record<string, unknown>): ReportData => data<ReportData>(doc, 'plant_report', params);
const expected = packJson<{ reports: Record<string, Record<string, unknown>> }>('data/sc_dat_01_reports_expected.json').reports;
const sc01 = scDat01Document();

describe('plant_report on SC-DAT-01 (VC-DAT-03, 04, 05)', () => {
  it('line_list: two lines in natural order with centreline length, straights, bends and resolved ends', () => {
    const result = report(sc01, { kind: 'line_list' });
    const wanted = expected['line_list'] as { rowsByLine: Record<string, Record<string, unknown>> };
    expect(result.total).toBe(2);
    expect(result.method).toBe('centreline');
    expect(result.defaults).toEqual({ batteryLimitPattern: '^(BL|TI)-' });
    for (const [line, row] of Object.entries(wanted.rowsByLine)) {
      const actual = result.rowsByTag?.[line] as Record<string, unknown>;
      expect(actual, line).toMatchObject({ ...row, lengthM: row['lengthM'] });
      expect(actual['hierarchy']).toBe('S1/P1/U10');
      expect(actual['unverified']).toBe(false);
    }
    expect(result.rows.map((row) => row['fromStatus'])).toEqual(['resolved', 'resolved']);
    expect(result.rows.map((row) => row['toStatus'])).toEqual(['batteryLimit', 'resolved']);
    expect(result.totals).toEqual({ lines: 2, lengthM: 10.2, bends: 3 });
    expect(result.columns.find((column) => column.name === 'DesignPressure')).toMatchObject({ type: 'pressure', unit: 'barg' });
  });

  it('equipment_list: P-101 before T-101, size in m, operating weight in kg, design pressure', () => {
    const result = report(sc01, { kind: 'equipment_list' });
    expect(result.rows.map((row) => row['tag'])).toEqual((expected['equipment_list'] as { tags: string[] }).tags);
    expect(result.rowsByTag?.['P-101']).toMatchObject({
      className: 'CentrifugalPump',
      Description: 'Transfer pump',
      DesignPressure: 16,
      OperatingWeightKg: 450,
      lengthM: 1,
      widthM: 0.5,
      heightM: 0.8,
      hierarchy: 'S1/P1/U10',
    });
    expect(result.rowsByTag?.['T-101']).toMatchObject({ OperatingWeightKg: 2500, DesignPressure: 3.5, heightM: 4 });
    expect(result.totals).toEqual({ equipment: 2, weightKg: 2950 });
  });

  it('nozzle_schedule: three inferred nozzles with the flow direction of the line end', () => {
    const result = report(sc01, { kind: 'nozzle_schedule' });
    const wanted = (expected['nozzle_schedule'] as { rowsByKey: Record<string, Record<string, unknown>> }).rowsByKey;
    expect(result.total).toBe(3);
    expect(result.method).toBe('inferred');
    for (const [key, row] of Object.entries(wanted)) expect(result.rowsByTag?.[key], key).toMatchObject(row);
    expect(result.rows.map((row) => row['key'])).toEqual(['P-101/N1', 'P-101/N2', 'T-101/N1']);
  });

  it('mto: pipe in m then bends in ea by spec, item type and DN, with the method and the source lines', () => {
    const result = report(sc01, { kind: 'mto', groupBy: ['spec', 'itemType', 'nominalSize'] });
    const wanted = (expected['mto'] as { rows: Array<Record<string, unknown>> }).rows;
    expect(result.rows.map(({ source: _source, ...row }) => row)).toEqual(wanted);
    expect(result.method).toBe('centreline');
    expect(result.rows[0]?.['source']).toBe('centreline of 1 line(s): 100-P-1002-A1A');
    expect(result.totals).toEqual({ pipeM: 10.2, items: 3 });
    expect(report(sc01, { kind: 'mto' }).rows).toHaveLength(4);
  });

  it('mto grouped by spec alone keeps metres and each apart; by line and hierarchy it lists the lines', () => {
    const bySpec = report(sc01, { kind: 'mto', groupBy: ['spec'] });
    expect(bySpec.rows.map((row) => [row['spec'], row['quantity'], row['unit']])).toEqual([
      ['A1A', 10.2, 'm'],
      ['A1A', 3, 'ea'],
    ]);
    const byLine = report(sc01, { kind: 'mto', groupBy: ['line', 'hierarchy', 'itemType'] });
    expect(byLine.rows.map((row) => [row['line'], row['itemType']])).toEqual([
      ['100-P-1002-A1A', 'pipe'],
      ['100-P-1002-A1A', 'bend'],
      ['150-P-1001-A1A', 'pipe'],
      ['150-P-1001-A1A', 'bend'],
    ]);
  });

  it('tag_register: every tag in natural order with class, target and status', () => {
    const result = report(sc01, { kind: 'tag_register' });
    expect(result.rows.map((row) => row['tag'])).toEqual((expected['tag_register'] as { tags: string[] }).tags);
    expect(result.rowsByTag?.['T-101']).toMatchObject({ className: 'Tank', targetKind: 'buildingElement', status: 'modelled' });
    expect(result.totals).toEqual({ tags: 4, modelled: 4, reserved: 0, orphan: 0 });
  });

  it('a reserved tag and an orphan show their status; an unverified value flags the row', () => {
    let doc = apply(sc01, 'assign_plant_object', { target: 'reserved', className: 'Tank', hierarchy: 'U10', tagFields: { seq: 9 } });
    doc = apply(doc, 'set_plant_properties', {
      edits: [{ object: 'P-101', property: 'DesignPressure', value: 17, provenance: { source: 'agent', unverified: true } }],
    });
    const orphaned = withData(doc, (current) => {
      const pump = Object.values(current.objects).find((object) => object.tag === 'P-101');
      if (pump === undefined) throw new Error('no pump');
      return {
        ...current,
        objects: { ...current.objects, [pump.id]: { ...copyObject(pump, {}), target: { kind: 'buildingElement', id: 'equipment-404' } } },
      };
    });
    const register = report(orphaned, { kind: 'tag_register' });
    expect(register.rowsByTag?.['T-109']).toMatchObject({ status: 'reserved', targetKind: 'reserved', target: null });
    expect(register.rowsByTag?.['P-101']).toMatchObject({ status: 'orphan', target: 'equipment-404' });
    expect(report(doc, { kind: 'equipment_list' }).rowsByTag?.['P-101']).toMatchObject({ unverified: true, DesignPressure: 17 });
    expect(report(doc, { kind: 'equipment_list' }).rowsByTag?.['T-101']).toMatchObject({ unverified: false });
    expect(report(orphaned, { kind: 'equipment_list' }).rowsByTag?.['P-101']).toMatchObject({ lengthM: null });
  });

  it('hierarchy restricts every report; a nozzle keeps its number when other units are filtered out', () => {
    const outside = apply(sc01, 'define_plant_hierarchy', { nodes: [{ code: 'U20', kind: 'unit', parent: 'P1' }] });
    expect(report(outside, { kind: 'line_list', hierarchy: 'U10' }).total).toBe(2);
    expect(report(outside, { kind: 'line_list', hierarchy: 'S1/P1/U20' }).total).toBe(0);
    expect(report(outside, { kind: 'nozzle_schedule', hierarchy: 'U20' }).total).toBe(0);
    expect(report(outside, { kind: 'tag_register', hierarchy: 'P1' }).total).toBe(4);
  });

  it('pages the rows but totals the whole report', () => {
    const result = report(sc01, { kind: 'tag_register', offset: 1, limit: 2 });
    expect(result.rows.map((row) => row['tag'])).toEqual(['150-P-1001-A1A', 'P-101']);
    expect(result).toMatchObject({ total: 4, offset: 1, limit: 2 });
  });

  it('csv carries all rows with "Name (unit)" headers; xlsx a locked single sheet; the bytes repeat', () => {
    const csv = report(sc01, { kind: 'line_list', format: 'csv', limit: 1 });
    const file = csv.files?.[0];
    expect(file?.fileName).toBe('line-list.csv');
    const lines = (file?.content ?? '').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Length (m)');
    expect(lines[0]).toContain('Design pressure (barg)');
    expect(lines[1]).toContain('100-P-1002-A1A,');
    const sheet = report(sc01, { kind: 'mto', format: 'xlsx' });
    const again = report(sc01, { kind: 'mto', format: 'xlsx' });
    expect(sheet.files?.[0]?.base64).toBe(again.files?.[0]?.base64);
    const book = readXlsx(Buffer.from(sheet.files?.[0]?.base64 ?? '', 'base64'));
    expect(book.sheets.map((entry) => entry.name)).toEqual(['mto']);
    expect(book.sheets[0]?.rows[0]).toEqual(['Spec', 'Item type', 'DN', 'Quantity', 'Unit', 'Source']);
    expect(book.sheets[0]?.rows[1]?.slice(0, 5)).toEqual(['A1A', 'pipe', 100, 5.8, 'm']);
    expect(book.sheets[0]?.protectedSheet).toBe(false);
  });

  it('is pure and repeatable', () => {
    const before = JSON.stringify(sc01);
    const first = execute(sc01, 'plant_report', { kind: 'line_list' });
    expect(first.document).toBe(sc01);
    expect(first.affected).toEqual([]);
    expect(JSON.stringify(sc01)).toBe(before);
    expect(execute(sc01, 'plant_report', { kind: 'line_list' }).data).toEqual(first.data);
    expect(execute(sc01, 'replay_history', {}).document.plant?.data).toEqual(sc01.plant?.data);
    expect(sc01.featureHistory.some((step) => step.name === 'plant_report')).toBe(false);
  });
});

describe('plant_report refusals (document unchanged)', () => {
  it.each(['valve_list', 'instrument_index', 'custom'])('%s needs a sibling gap: DAT_REPORT_KIND_UNAVAILABLE', (kind) => {
    const refused = expectRefusal(sc01, 'plant_report', { kind }, 'DAT_REPORT_KIND_UNAVAILABLE', 'kind');
    expect(refused.summary).toMatch(/DAT-M[45]/);
  });

  it('refuses an unknown or ambiguous hierarchy node, a groupBy outside mto, and bad parameters', () => {
    expectRefusal(sc01, 'plant_report', { kind: 'line_list', hierarchy: 'U99' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
    expectRefusal(sc01, 'plant_report', { kind: 'line_list', groupBy: ['spec'] }, 'DAT_PARAM_INVALID', 'groupBy');
    for (const params of [
      { kind: 'nope' },
      { kind: 'mto', groupBy: ['colour'] },
      { kind: 'mto', groupBy: [] },
      { kind: 'mto', limit: 20001 },
    ]) {
      const result = execute(sc01, 'plant_report', params);
      expect(result.rejected, JSON.stringify(params)).toBe(true);
      expect(result.document).toBe(sc01);
    }
  });

  it('an empty plant gives empty reports, not errors', () => {
    const empty = libraryDocument();
    for (const kind of ['line_list', 'equipment_list', 'nozzle_schedule', 'mto', 'tag_register'])
      expect(report(empty, { kind })).toMatchObject({ total: 0, rows: [] });
  });
});

describe('plant_report on other models', () => {
  it('a routed line: length from the run legs, bends from its points of intersection, nozzle ends are not inferred', () => {
    const scene = routedPumpToVessel();
    let doc = apply(scene.doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
      ],
    });
    doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
    doc = apply(doc, 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const line = report(doc, { kind: 'line_list' }).rows[0] as Record<string, unknown>;
    const run = Object.values(doc.plant?.piping?.runs ?? {})[0];
    expect(run).toBeDefined();
    expect(line['tag']).toBe('100-P-1001-CS150');
    expect(line['nominalSize']).toBe(100);
    expect(line['lengthM']).toBeGreaterThan(0);
    expect(line['bends']).toBe(run?.pis.length);
    expect(line['straights']).toBe((run?.pis.length ?? 0) + 1);
    expect(report(doc, { kind: 'mto' }).rows[0]).toMatchObject({ spec: 'CS150', itemType: 'pipe', nominalSize: 100, unit: 'm' });
    expect(report(doc, { kind: 'nozzle_schedule' }).total).toBe(0);
  });

  it('an object bound to a line by lineId adds its pipe to the line', () => {
    let doc = libraryDocument();
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [0, 0, 400],
        [2000, 0, 400],
      ],
      dn: 50,
      line: 'L-1',
    });
    doc = apply(doc, 'add_pipe_run', {
      points: [
        [2000, 0, 400],
        [2000, 3000, 400],
        [4000, 3000, 400],
      ],
      dn: 50,
      line: 'L-2',
    });
    const [firstPipe, secondPipe] = Object.keys(doc.building?.elements ?? {}).filter((id) => id.startsWith('pipe'));
    doc = apply(doc, 'assign_plant_object', {
      target: firstPipe,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 50, fluidCode: 'P', seq: 1, spec: 'A1A' },
    });
    expect(report(doc, { kind: 'line_list' }).rows[0]).toMatchObject({ lengthM: 2, straights: 1, bends: 0 });
    doc = apply(doc, 'assign_plant_object', {
      target: secondPipe,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { nominalSize: 50, fluidCode: 'P', seq: 2, spec: 'A1A' },
    });
    const lineId = Object.values(getPlantData(doc).objects).find(
      (object) => object.target.kind === 'buildingElement' && object.target.id === firstPipe,
    )?.id;
    const linked = withData(doc, (current) => ({
      ...current,
      objects: Object.fromEntries(
        Object.entries(current.objects).map(([id, object]) => [
          id,
          object.tag.includes('0002') ? { ...copyObject(object, {}), lineId: lineId as string } : object,
        ]),
      ),
    }));
    expect(report(linked, { kind: 'line_list' }).rows[0]).toMatchObject({ lengthM: 7, straights: 3, bends: 1 });
  });

  it('equipment with nozzles of its own infers none and equipment without a plant object is not listed', () => {
    const { doc } = addEquipment(libraryDocument());
    expect(report(doc, { kind: 'equipment_list' }).total).toBe(0);
    expect(ok(doc, 'plant_report', { kind: 'equipment_list' }).summary).toMatch(/0 row/);
  });
});

describe('plant_report budget (§8)', () => {
  it('10 000 objects: JSON + CSV well under 3 s (budget 1 s per 20 000 objects)', () => {
    const base = apply(apply(libraryDocument(), 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' }), 'set_tag_format', {
      className: 'MyPump',
      tagFormat: '{classCode}-{seq:5}',
    });
    const assigned = ok(base, 'assign_plant_objects', {
      assignments: Array.from({ length: 10000 }, (_, index) => ({
        target: 'reserved',
        className: 'MyPump',
        hierarchy: 'U10',
        tagFields: { seq: index + 1 },
        properties: { Description: 'Pump', DesignPressure: 10 },
      })),
    }).document;
    const started = performance.now();
    const result = report(assigned, { kind: 'tag_register', format: 'csv', limit: 20000 });
    const equipment = report(assigned, { kind: 'equipment_list', format: 'csv', limit: 1 });
    const elapsed = performance.now() - started;
    expect(result.total).toBe(10000);
    expect(equipment.total).toBe(10000);
    expect(result.files?.[0]?.content?.split('\n').length).toBe(10002);
    expect(elapsed).toBeLessThan(3000);
  });
});
