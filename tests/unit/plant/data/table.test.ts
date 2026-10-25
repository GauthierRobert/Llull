/**
 * Plant 08 DAT M1: `plant_data_table` (columns with types and units, natural tag order, paging, filters, hierarchy) and `unassign_plant_object`.
 */

import type { CadDocument } from '@core/model/types';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addEquipment, assignPump, libraryDocument } from './dataFixtures';

interface Table {
  columns: Array<{ name: string; displayName: string; type: string; unit: string | null; readOnly: boolean }>;
  rows: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  classes?: Array<{ name: string; parent: string | null; abstract: boolean; source: string; objects: number }>;
}

/** Eleven pumps P-101 ... P-111 in U10 and one tank T-101 in U20 (P2); pumps get Service "feed" on every third. */
function plant(): CadDocument {
  let doc = apply(libraryDocument(), 'define_plant_hierarchy', {
    nodes: [{ code: 'U20', kind: 'unit', parent: 'P2', properties: { areaNumber: '1' } }],
  });
  for (let index = 1; index <= 11; index += 1) {
    const added = addEquipment(doc, { name: `Pump ${index}`, weight: index * 10 });
    doc = assignPump(added.doc, added.id, {
      properties: { Description: `Pump ${index}`, DesignPressure: index, ...(index % 3 === 0 ? { Service: 'feed' } : {}) },
    }).doc;
  }
  doc = apply(doc, 'assign_plant_object', {
    target: 'reserved',
    className: 'Tank',
    hierarchy: 'U20',
    nextSequence: true,
    properties: { Description: 'Tank', DesignPressure: 2 },
  });
  return doc;
}

const table = (doc: ReturnType<typeof plant>, params: Record<string, unknown> = {}): Table => data<Table>(doc, 'plant_data_table', params);

describe('plant_data_table', () => {
  it('lists every object with the base columns, the class list and natural tag order (P-2 before P-10)', () => {
    const result = table(plant());
    expect(result.total).toBe(12);
    expect(result.rows.map((row) => row['tag'])).toEqual([
      'P-101',
      'P-102',
      'P-103',
      'P-104',
      'P-105',
      'P-106',
      'P-107',
      'P-108',
      'P-109',
      'P-110',
      'P-111',
      'T-101',
    ]);
    expect(result.columns.slice(0, 6).map((column) => column.name)).toEqual([
      'id',
      'tag',
      'className',
      'hierarchy',
      'target',
      'unverified',
    ]);
    expect(result.classes?.find((cls) => cls.name === 'CentrifugalPump')).toEqual({
      name: 'CentrifugalPump',
      parent: 'Equipment',
      abstract: false,
      source: 'library',
      objects: 11,
    });
    expect(result.rows[0]).toMatchObject({ className: 'CentrifugalPump', hierarchy: 'S1/P1/U10', DesignPressure: 1, OperatingWeight: 10 });
    expect(result.rows[11]).toMatchObject({ className: 'Tank', hierarchy: 'S1/P2/U20', target: 'reserved' });
  });

  it('types the property columns with their unit and read-only flag', () => {
    const columns = table(plant(), { className: 'CentrifugalPump' }).columns;
    expect(columns.find((column) => column.name === 'DesignPressure')).toMatchObject({
      type: 'pressure',
      unit: 'barg',
      readOnly: false,
      displayName: 'Design pressure',
    });
    expect(columns.find((column) => column.name === 'FlowRate')).toMatchObject({ type: 'volumetricFlow', unit: 'm3/h' });
    expect(columns.find((column) => column.name === 'tag')).toMatchObject({ readOnly: true });
  });

  it('restricts by class (with or without subclasses), hierarchy, filter and columns, sorts and pages', () => {
    const doc = plant();
    expect(table(doc, { className: 'Equipment' }).total).toBe(12);
    expect(table(doc, { className: 'Equipment', includeSubclasses: false }).total).toBe(0);
    expect(table(doc, { className: 'Tank' }).rows.map((row) => row['tag'])).toEqual(['T-101']);
    expect(table(doc, { hierarchy: 'U20' }).total).toBe(1);
    expect(table(doc, { hierarchy: 'S1/P1' }).total).toBe(11);
    expect(table(doc, { filter: { Service: 'feed' } }).rows.map((row) => row['tag'])).toEqual(['P-103', 'P-106', 'P-109']);
    expect(
      table(doc, { className: 'CentrifugalPump', columns: ['tag', 'DesignPressure'], sort: ['-DesignPressure'], limit: 3 }).rows,
    ).toEqual([
      { tag: 'P-111', DesignPressure: 11 },
      { tag: 'P-110', DesignPressure: 10 },
      { tag: 'P-109', DesignPressure: 9 },
    ]);
    const page = table(doc, { className: 'CentrifugalPump', columns: ['tag'], offset: 9, limit: 5 });
    expect(page).toMatchObject({ total: 11, offset: 9, limit: 5 });
    expect(page.rows.map((row) => row['tag'])).toEqual(['P-110', 'P-111']);
    expect(
      table(doc, { className: 'CentrifugalPump', columns: ['tag', 'Service'], sort: ['Service', 'tag'], limit: 4 }).rows.map(
        (row) => row['tag'],
      ),
    ).toEqual(['P-103', 'P-106', 'P-109', 'P-101']);
  });

  it('refuses an unknown class, hierarchy node or column', () => {
    const doc = plant();
    expectRefusal(doc, 'plant_data_table', { className: 'Nope' }, 'DAT_CLASS_UNKNOWN', 'className');
    expectRefusal(doc, 'plant_data_table', { hierarchy: 'U99' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
    expectRefusal(doc, 'plant_data_table', { columns: ['tag', 'Colour'] }, 'DAT_COLUMN_UNKNOWN', 'columns');
    expectRefusal(doc, 'plant_data_table', { filter: { Colour: 'red' } }, 'DAT_COLUMN_UNKNOWN', 'filter');
    expectRefusal(doc, 'plant_data_table', { sort: ['-Colour'] }, 'DAT_COLUMN_UNKNOWN', 'sort');
  });

  it('shows an orphan as such, is read-only and answers the same twice', () => {
    const doc = apply(plant(), 'delete_building_element', { elementIds: ['equipment-1'] });
    expect(table(doc, { columns: ['tag', 'target'], limit: 1 }).rows[0]).toEqual({ tag: 'P-101', target: 'orphan: equipment-1' });
    const before = structuredClone(doc);
    const first = execute(doc, 'plant_data_table', {});
    expect(first.document).toBe(doc);
    expect(doc).toEqual(before);
    expect(execute(doc, 'plant_data_table', {}).data).toEqual(first.data);
  });
});

describe('unassign_plant_object', () => {
  it('removes objects by id or tag, frees their tags and leaves the model object with the tag it carries', () => {
    const doc = plant();
    const ids = getPlantData(doc).objectOrder;
    const result = ok(doc, 'unassign_plant_object', { objects: ['P-101', ids[1] as string] });
    expect(result.data).toMatchObject({
      removed: [
        { id: ids[0], tag: 'P-101' },
        { id: ids[1], tag: 'P-102' },
      ],
      detached: [],
    });
    expect(result.affected).toEqual([ids[0], ids[1]]);
    expect(getPlantData(result.document).objectOrder).toHaveLength(10);
    expect(
      result.document.building?.elements['equipment-1']?.category === 'equipment' && result.document.building.elements['equipment-1'].mark,
    ).toBe('P-101');
    const again = data<{ tag: string }>(result.document, 'assign_plant_object', {
      target: 'equipment-1',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tag: 'P-101',
    });
    expect(again.tag).toBe('P-101');
  });

  it('detaches the pipes and components that named a removed line', () => {
    let doc = libraryDocument();
    const pipe = apply(doc, 'add_pipe_run', {
      points: [
        [0, 0, 400],
        [2000, 0, 400],
      ],
      dn: 50,
      line: 'L-9',
    });
    const pipeId = Object.keys(pipe.building?.elements ?? {}).find((id) => id.startsWith('pipe')) as string;
    doc = apply(pipe, 'assign_plant_object', {
      target: pipeId,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { fluidCode: 'P', seq: 1, spec: 'A1' },
    });
    const line = getPlantData(doc).objectOrder[0] as string;
    doc = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      nextSequence: true,
      line: '50-P-0001-A1',
      properties: { Description: 'x', DesignPressure: 1 },
    });
    const member = getPlantData(doc).objectOrder[1] as string;
    expect(getPlantData(doc).objects[member]?.lineId).toBe(line);
    const removed = ok(doc, 'unassign_plant_object', { objects: [line] });
    expect(removed.data).toMatchObject({ detached: [member] });
    expect(getPlantData(removed.document).objects[member]?.lineId).toBeUndefined();
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'reserved', className: 'CentrifugalPump', hierarchy: 'U10', nextSequence: true, line: member },
      'DAT_OBJECT_UNKNOWN',
      'line',
    );
  });

  it('refuses an unknown object and applies nothing; is pure', () => {
    const doc = plant();
    expectRefusal(doc, 'unassign_plant_object', { objects: ['P-101', 'NOPE'] }, 'DAT_OBJECT_UNKNOWN', 'objects[1]');
    const before = structuredClone(doc);
    execute(doc, 'unassign_plant_object', { objects: ['P-101'] });
    expect(doc).toEqual(before);
  });

  it('an ambiguous tag (two plants) must be given as the id', () => {
    const doc = plant();
    const twin = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'CentrifugalPump',
      hierarchy: 'U20',
      tagFields: { seq: 1 },
      properties: { Description: 'x', DesignPressure: 1 },
    });
    expectRefusal(twin, 'unassign_plant_object', { objects: ['P-101'] }, 'DAT_OBJECT_UNKNOWN', 'objects[0]');
  });
});
