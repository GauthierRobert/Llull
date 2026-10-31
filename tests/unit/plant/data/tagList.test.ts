/** Plant 08 DAT-M4: `import_tag_list`, `renumber_tags` (VC-DAT-18) and report definitions (VC-DAT-19, `save_report_definition`). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import { plantDataErrors } from '@aec/plant/data/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { libraryDocument, scDat01Document } from './dataFixtures';

interface TagListResult {
  reserved: number;
  created: Array<{ objectId: string; tag: string }>;
  rejected: Array<{ tag?: string; code: string; cell: string; row: number }>;
  rejectedCount: number;
  documentChanged: boolean;
}

const sc01 = scDat01Document();
const CLIENT_LIST = 'Tag,Description\nP-103,Booster pump\nP-104,Spare pump\nP-101,Duplicate of the modelled pump\n';
const list = { className: 'CentrifugalPump', hierarchy: 'U10', csv: CLIENT_LIST };
const tagsOf = (doc: typeof sc01): string[] => getPlantData(doc).objectOrder.map((id) => getPlantData(doc).objects[id]?.tag ?? '');

describe('import_tag_list (FR-DAT-15, VC-DAT-18)', () => {
  it('preview reports 2 reserved and P-101 as DAT_TAG_DUPLICATE and changes nothing', () => {
    const result = ok(sc01, 'import_tag_list', list);
    expect(result.document).toBe(sc01);
    const listed = result.data as TagListResult;
    expect(listed.reserved).toBe(2);
    expect(listed.rejected).toMatchObject([{ tag: 'P-101', code: 'DAT_TAG_DUPLICATE', cell: 'A4', row: 4 }]);
    expect(listed.documentChanged).toBe(false);
  });

  it('apply refuses the whole list by default (atomic) and reserves the valid rows with onRejected skip, as ONE step with import provenance', () => {
    const refused = expectRefusal(sc01, 'import_tag_list', { ...list, mode: 'apply' }, 'DAT_TAG_DUPLICATE', 'csv!A4');
    expect(refused.document).toBe(sc01);
    const result = ok(sc01, 'import_tag_list', { ...list, mode: 'apply', onRejected: 'skip' });
    expect(result.data).toMatchObject({ reserved: 2, rejectedCount: 1, documentChanged: true });
    expect(tagsOf(result.document)).toEqual([...tagsOf(sc01), 'P-103', 'P-104']);
    expect(result.document.featureHistory.length).toBe(sc01.featureHistory.length + 1);
    const reserved = Object.values(getPlantData(result.document).objects).filter((object) => object.target.kind === 'reserved');
    expect(reserved.map((object) => object.properties['Description'])).toEqual(['Booster pump', 'Spare pump']);
    expect(reserved[0]?.provenance?.['Description']).toMatchObject({ source: 'import' });
    expect(reserved.map((object) => object.id)).toEqual(result.affected);
  });

  it('a reserved tag counts in the registry and the report: tag_register lists it as reserved', () => {
    const result = apply(sc01, 'import_tag_list', { ...list, mode: 'apply', onRejected: 'skip' });
    const register = data<{ rows: Array<{ tag: string; status: string }> }>(result, 'plant_report', { kind: 'tag_register' });
    expect(register.rows.filter((row) => row.status === 'reserved').map((row) => row.tag)).toEqual(['P-103', 'P-104']);
  });

  it('rejects a repeated tag of the file, a malformed tag, a bad value and an unknown column, each with its cell', () => {
    const csv = 'Tag,Description,DesignPressure (barg),Mystery\nP-105,a,12,x\nP-105,b,12,x\nPUMP-9,c,1,x\nP-106,d,notanumber,x\n,e,1,x\n';
    const listed = data<TagListResult>(sc01, 'import_tag_list', { className: 'CentrifugalPump', hierarchy: 'U10', csv });
    expect(listed.reserved).toBe(1);
    expect(listed.rejected.map((entry) => [entry.cell, entry.code])).toEqual([
      ['D1', 'DAT_IMPORT_UNKNOWN_COLUMN'],
      ['A3', 'DAT_TAG_DUPLICATE'],
      ['A4', 'DAT_TAG_FORMAT'],
      ['C5', 'DAT_IMPORT_TYPE'],
      ['A6', 'DAT_IMPORT_KEY_MISSING'],
    ]);
  });

  it('refuses without a Tag column, with an unknown or abstract class and an unknown hierarchy, and an unreadable source', () => {
    expectRefusal(sc01, 'import_tag_list', { ...list, csv: 'Description\nx' }, 'DAT_IMPORT_KEY_MISSING');
    expectRefusal(sc01, 'import_tag_list', { ...list, className: 'Nope' }, 'DAT_CLASS_UNKNOWN');
    expectRefusal(sc01, 'import_tag_list', { ...list, className: 'Equipment' }, 'DAT_CLASS_ABSTRACT');
    expectRefusal(sc01, 'import_tag_list', { ...list, hierarchy: 'Nowhere' }, 'DAT_HIERARCHY_UNKNOWN');
    expectRefusal(sc01, 'import_tag_list', { className: 'CentrifugalPump', hierarchy: 'U10' }, 'DAT_PARAM_INVALID');
    expectRefusal(sc01, 'import_tag_list', { ...list, csv: '"unterminated' }, 'DAT_IMPORT_FORMAT');
    expectRefusal(sc01, 'import_tag_list', { ...list, csv: `Tag\n${'P-1\n'.repeat(10001)}` }, 'DAT_IMPORT_FORMAT');
  });

  it('is pure and replays to the same plant data', () => {
    const before = JSON.stringify(sc01);
    const applied = ok(sc01, 'import_tag_list', { ...list, mode: 'apply', onRejected: 'skip' });
    expect(JSON.stringify(sc01)).toBe(before);
    expect(getPlantData(execute(applied.document, 'replay_history', {}).document)).toEqual(getPlantData(applied.document));
  });

  it('reserves 10 000 tags through the bulk path inside the budget', () => {
    const doc = apply(apply(libraryDocument(), 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' }), 'set_tag_format', {
      className: 'MyPump',
      tagFormat: '{classCode}-{seq:5}',
    });
    const csv = `Tag\n${Array.from({ length: 10000 }, (_, k) => `P-${String(k + 1).padStart(5, '0')}`).join('\n')}\n`;
    const started = performance.now();
    const result = ok(doc, 'import_tag_list', { className: 'MyPump', hierarchy: 'U10', csv, mode: 'apply' });
    expect(performance.now() - started).toBeLessThan(15000);
    expect((result.data as TagListResult).reserved).toBe(10000);
  });
});

describe('renumber_tags (FR-DAT-26, VC-DAT-18)', () => {
  const imported = apply(sc01, 'import_tag_list', { ...list, mode: 'apply', onRejected: 'skip' });

  it('P-101 -> P-111, P-103 -> P-112, P-104 -> P-113 from 11, written back to the equipment mark', () => {
    const result = ok(imported, 'renumber_tags', { className: 'CentrifugalPump', hierarchy: 'U10', startSequence: 11 });
    const mapping = (result.data as { mapping: Array<{ from: string; to: string }> }).mapping;
    expect(mapping.map((entry) => [entry.from, entry.to])).toEqual([
      ['P-101', 'P-111'],
      ['P-103', 'P-112'],
      ['P-104', 'P-113'],
    ]);
    expect(tagsOf(result.document)).toContain('P-113');
    const marks = Object.values(result.document.building?.elements ?? {}).flatMap((element) =>
      element.category === 'equipment' ? [element.mark] : [],
    );
    expect(marks.sort()).toEqual(['P-111', 'T-101']);
    expect(result.document.featureHistory.length).toBe(imported.featureHistory.length + 1);
    expect(
      data<{ rowsByTag: Record<string, unknown> }>(result.document, 'plant_report', { kind: 'equipment_list' }).rowsByTag,
    ).toHaveProperty('P-111');
  });

  it('step spaces the numbers, a permutation is valid, and renumbering to the same numbers changes nothing', () => {
    const stepped = ok(imported, 'renumber_tags', { className: 'CentrifugalPump', startSequence: 10, step: 5 });
    expect((stepped.data as { mapping: Array<{ to: string }> }).mapping.map((entry) => entry.to)).toEqual(['P-110', 'P-115', 'P-120']);
    const same = execute(imported, 'renumber_tags', { className: 'CentrifugalPump', startSequence: 1, step: 1 });
    expect(same.rejected).toBeUndefined();
    expect((same.data as { mapping: Array<{ from: string; to: string }> }).mapping.map((entry) => [entry.from, entry.to])).toEqual([
      ['P-103', 'P-102'],
      ['P-104', 'P-103'],
    ]);
    const swapped = ok(same.document, 'renumber_tags', { className: 'CentrifugalPump', startSequence: 1 });
    expect((swapped.data as { count: number }).count).toBe(0);
    expect(swapped.document).toBe(same.document);
  });

  it('refuses an overflow of the padded width, a collision outside the selection, an unknown class / node and a format without a sequence', () => {
    expectRefusal(imported, 'renumber_tags', { className: 'CentrifugalPump', startSequence: 99 }, 'DAT_RENUMBER_RANGE', 'startSequence');
    const outside = apply(imported, 'assign_plant_object', { target: 'reserved', className: 'Tank', hierarchy: 'U10', tag: 'T-199' });
    expectRefusal(outside, 'renumber_tags', { className: 'Tank', startSequence: 100 }, 'DAT_RENUMBER_RANGE');
    expectRefusal(imported, 'renumber_tags', { className: 'Nope', startSequence: 1 }, 'DAT_CLASS_UNKNOWN');
    expectRefusal(
      imported,
      'renumber_tags',
      { className: 'CentrifugalPump', hierarchy: 'Nowhere', startSequence: 1 },
      'DAT_HIERARCHY_UNKNOWN',
    );
    const fixed = apply(
      apply(imported, 'define_plant_class', { name: 'Fixed', parent: 'Equipment', classCode: 'F', tagFormat: '{classCode}-MAIN' }),
      'assign_plant_object',
      { target: 'reserved', className: 'Fixed', hierarchy: 'U10' },
    );
    expectRefusal(fixed, 'renumber_tags', { className: 'Fixed', startSequence: 1 }, 'DAT_TAG_FORMAT', 'className');
  });

  it('collides with a tag held outside the selection: DAT_TAG_DUPLICATE and nothing changes', () => {
    const split = apply(imported, 'define_plant_hierarchy', {
      nodes: [{ code: 'U20', kind: 'unit', parent: 'P1', properties: { areaNumber: '1' } }],
    });
    const moved = apply(split, 'import_tag_list', { className: 'CentrifugalPump', hierarchy: 'U20', csv: 'Tag\nP-111\n', mode: 'apply' });
    const refused = expectRefusal(
      moved,
      'renumber_tags',
      { className: 'CentrifugalPump', hierarchy: 'U10', startSequence: 11 },
      'DAT_TAG_DUPLICATE',
    );
    expect(refused.error?.ids.length).toBeGreaterThan(1);
  });

  it('is pure', () => {
    const before = JSON.stringify(imported);
    ok(imported, 'renumber_tags', { className: 'CentrifugalPump', startSequence: 11 });
    expect(JSON.stringify(imported)).toBe(before);
  });
});

describe('save_report_definition and plant_report { definition } (FR-DAT-27, VC-DAT-19)', () => {
  const saved = apply(sc01, 'save_report_definition', {
    id: 'weights-t',
    kind: 'equipment_list',
    columns: ['tag', 'OperatingWeightKg', 'WeightT'],
    computed: [{ name: 'WeightT', displayName: 'Weight', unit: 't', expression: 'OperatingWeightKg / 1000' }],
    sort: ['-OperatingWeightKg'],
  });

  it('computes the column per row (T-101 2.5 t, P-101 0.45 t), keeps and orders the columns, sorts, and writes the file header "Weight (t)"', () => {
    const report = data<{
      columns: Array<{ name: string }>;
      rows: Array<Record<string, unknown>>;
      rowsByTag: Record<string, Record<string, unknown>>;
      files: Array<{ content: string }>;
    }>(saved, 'plant_report', { definition: 'weights-t', format: 'csv' });
    expect(report.columns.map((column) => column.name)).toEqual(['tag', 'OperatingWeightKg', 'WeightT']);
    expect(report.rows.map((row) => [row['tag'], row['WeightT']])).toEqual([
      ['T-101', 2.5],
      ['P-101', 0.45],
    ]);
    expect(report.files[0]?.content.split('\n')[0]).toBe('Tag,Operating weight (kg),Weight (t)');
  });

  it('filters rows and refuses unknown columns, bad expressions, bad ids and an unavailable kind', () => {
    const tanks = apply(sc01, 'save_report_definition', {
      id: 'tanks',
      kind: 'equipment_list',
      filter: { className: 'Tank' },
      columns: ['tag'],
    });
    expect(data<{ rows: unknown[] }>(tanks, 'plant_report', { definition: 'tanks' }).rows).toEqual([{ tag: 'T-101' }]);
    expectRefusal(sc01, 'save_report_definition', { id: 'x', kind: 'equipment_list', columns: ['nope'] }, 'DAT_COLUMN_UNKNOWN', 'columns');
    expectRefusal(sc01, 'save_report_definition', { id: 'x', kind: 'equipment_list', sort: ['-nope'] }, 'DAT_COLUMN_UNKNOWN', 'sort');
    expectRefusal(sc01, 'save_report_definition', { id: 'x', kind: 'equipment_list', filter: { nope: 1 } }, 'DAT_COLUMN_UNKNOWN', 'filter');
    expectRefusal(
      sc01,
      'save_report_definition',
      { id: 'x', kind: 'equipment_list', computed: [{ name: 'A', displayName: 'A', expression: 'missing * 2' }] },
      'DAT_COLUMN_UNKNOWN',
      'computed',
    );
    expectRefusal(
      sc01,
      'save_report_definition',
      { id: 'x', kind: 'equipment_list', computed: [{ name: 'A', displayName: 'A', expression: '1 +' }] },
      'DAT_PARAM_INVALID',
      'computed',
    );
    expectRefusal(
      sc01,
      'save_report_definition',
      { id: 'x', kind: 'equipment_list', computed: [{ name: 'tag', displayName: 'A', expression: '1' }] },
      'DAT_PARAM_INVALID',
      'computed',
    );
    expectRefusal(sc01, 'save_report_definition', { id: '1 bad id', kind: 'mto' }, 'DAT_PARAM_INVALID', 'id');
    expectRefusal(sc01, 'save_report_definition', { id: 'x', kind: 'equipment_list', hierarchy: 'Nowhere' }, 'DAT_HIERARCHY_UNKNOWN');
  });

  it('replaces a definition of the same id, and plant_report refuses an unknown definition, a mismatching kind and neither kind nor definition', () => {
    const again = ok(saved, 'save_report_definition', { id: 'weights-t', kind: 'equipment_list' });
    expect(again.data).toMatchObject({ id: 'weights-t', replaced: true });
    expectRefusal(sc01, 'plant_report', { definition: 'missing' }, 'DAT_PARAM_INVALID', 'definition');
    expectRefusal(saved, 'plant_report', { definition: 'weights-t', kind: 'mto' }, 'DAT_PARAM_INVALID', 'kind');
    expectRefusal(saved, 'plant_report', {}, 'DAT_PARAM_INVALID', 'kind');
    expectRefusal(saved, 'plant_report', { kind: 'custom' }, 'DAT_REPORT_KIND_UNAVAILABLE');
  });

  it('is pure, survives replay, and a definition saved with a groupBy mto applies it', () => {
    const before = JSON.stringify(sc01);
    const mto = apply(sc01, 'save_report_definition', { id: 'mto-line', kind: 'mto', groupBy: ['line'] });
    expect(JSON.stringify(sc01)).toBe(before);
    expect(getPlantData(execute(mto, 'replay_history', {}).document).reports).toEqual(getPlantData(mto).reports);
    expect(data<{ rows: unknown[] }>(mto, 'plant_report', { definition: 'mto-line' }).rows.length).toBeGreaterThan(0);
  });
});

describe('saved report definitions on load', () => {
  const withReports = (reports: unknown): string[] => plantDataErrors({ ...getPlantData(sc01), reports });

  it('accepts a saved definition and refuses malformed ones with a path', () => {
    const saved = apply(sc01, 'save_report_definition', { id: 'a', kind: 'mto', filter: { spec: 'A1A' }, sort: ['-spec'] });
    expect(plantDataErrors(getPlantData(saved))).toEqual([]);
    expect(withReports('x')).toEqual(['plant.data.reports must be an object']);
    expect(withReports({ a: 5 })).toEqual(['plant.data.reports.a must be an object']);
    expect(withReports({ a: { id: 'b', kind: 'nope', columns: [1], hierarchy: 3, filter: { x: {} }, computed: [{}] } })).toHaveLength(6);
  });
});
