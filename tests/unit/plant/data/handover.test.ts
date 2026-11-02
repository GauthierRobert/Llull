/**
 * Plant 08 DAT-M6 (TR-DAT-29, VC-DAT-16): `export_handover`. The registers, the unverified CFIHOS-like profile (marked in the file name, the manifest, the data and the
 * summary), class ids from the project, byte-identical files, scope, refusals and the export gate; plus `define_plant_class` externalIds.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { getPlantData } from '@aec/plant/data/model';
import { plantDataErrors } from '@aec/plant/data/validate';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { boxOf, step } from '../../materials/support';
import { addEquipment, assignPump, libraryDocument, scDat01Document, withData } from './dataFixtures';

interface Handover {
  profile: string;
  unverified: boolean;
  mappingSource: string;
  notice: string;
  files: Array<{ fileName: string; content: string }>;
  registers: Record<string, { columns: string[]; rows: Array<Record<string, unknown>> }>;
  mapping: { scheme: string; mapped: number; missing: string[] };
  warnings: string[];
}

const AT = '2026-11-02T09:30:00Z';
const sc01 = scDat01Document();
const handover = (doc: CadDocument, params: Record<string, unknown>): Handover => data<Handover>(doc, 'export_handover', params);
const fileOf = (result: Handover, suffix: string): string => result.files.find((file) => file.fileName.includes(suffix))?.content ?? '';

describe('export_handover cfihos-subset (unverified)', () => {
  const result = handover(sc01, { profile: 'cfihos-subset' });

  it('is marked unverified everywhere: data, notice, every register file name, the manifest and the summary', () => {
    expect(result.unverified).toBe(true);
    expect(result.notice).toContain('UNVERIFIED');
    expect(result.mappingSource).toContain('not checked against an IOGP release');
    const registers = result.files.filter((file) => file.fileName.endsWith('.csv'));
    expect(registers.map((file) => file.fileName)).toEqual([
      'cfihos-subset-tag-register.unverified.csv',
      'cfihos-subset-equipment-register.unverified.csv',
      'cfihos-subset-tag-properties.unverified.csv',
      'cfihos-subset-document-register.unverified.csv',
    ]);
    const manifest = JSON.parse(fileOf(result, 'handover-manifest')) as {
      unverified: boolean;
      notice: string;
      files: Array<{ fileName: string; sha256: string; rows: number }>;
    };
    expect(manifest.unverified).toBe(true);
    expect(manifest.notice).toContain('UNVERIFIED');
    for (const entry of manifest.files) {
      expect(entry.sha256).toBe(sha256Hex(fileOf(result, entry.fileName)));
      expect(entry.rows).toBe(
        result.registers[
          entry.fileName
            .replace(/^cfihos-subset-/, '')
            .replace('.unverified.csv', '')
            .replace(/-/g, '_')
        ]?.rows.length,
      );
    }
    expect(execute(sc01, 'export_handover', { profile: 'cfihos-subset' }).summary).toContain('UNVERIFIED');
  });

  it('writes the tag register of SC-DAT-01 with the CFIHOS-like headers, hierarchy path, status and the parent of a line member', () => {
    const rows = result.registers['tag_register']?.rows ?? [];
    const objects = getPlantData(sc01).objectOrder.length;
    expect(rows).toHaveLength(objects);
    expect(result.registers['tag_register']?.columns).toEqual([
      'TAG_NUMBER',
      'TAG_CLASS_NAME',
      'TAG_CLASS_ID',
      'PARENT_TAG_NUMBER',
      'HIERARCHY_PATH',
      'TAG_DESCRIPTION',
      'TAG_STATUS',
    ]);
    const pump = rows.find((row) => row['TAG_NUMBER'] === 'P-101');
    expect(pump).toMatchObject({
      TAG_CLASS_NAME: 'CentrifugalPump',
      HIERARCHY_PATH: 'S1/P1/U10',
      TAG_STATUS: 'modelled',
      TAG_CLASS_ID: '',
    });
    expect(fileOf(result, 'tag-register').split('\n')[0]).toBe(
      'TAG_NUMBER,TAG_CLASS_NAME,TAG_CLASS_ID,PARENT_TAG_NUMBER,HIERARCHY_PATH,TAG_DESCRIPTION,TAG_STATUS',
    );
  });

  it('lists the classes without a cfihos id (library classes carry none) in mapping.missing and a warning, and leaves the class id empty', () => {
    expect(result.mapping.scheme).toBe('cfihos');
    expect(result.mapping.missing).toEqual(expect.arrayContaining(['CentrifugalPump', 'Tank']));
    expect(result.warnings[0]).toContain('DAT_HANDOVER_MAPPING_MISSING');
  });

  it('class ids come from classIds given with the export and from the externalIds of a project class', () => {
    const given = handover(sc01, { profile: 'cfihos-subset', classIds: { CentrifugalPump: 'X-PUMP', Tank: 'X-TANK' } });
    const rows = given.registers['tag_register']?.rows ?? [];
    expect(rows.find((row) => row['TAG_NUMBER'] === 'P-101')?.['TAG_CLASS_ID']).toBe('X-PUMP');
    expect(given.mapping.missing).not.toContain('Tank');
    const own = apply(libraryDocument(), 'define_plant_class', {
      name: 'FeedPump',
      parent: 'CentrifugalPump',
      externalIds: [{ scheme: 'cfihos', id: 'C-77' }],
    });
    const doc = assignPump(addEquipment(own, { name: 'F' }).doc, 'equipment-1', { className: 'FeedPump' }).doc;
    const mapped = handover(doc, { profile: 'cfihos-subset', requireMapping: true });
    expect(mapped.registers['tag_register']?.rows[0]).toMatchObject({ TAG_CLASS_ID: 'C-77' });
    expect(mapped.mapping).toEqual({ scheme: 'cfihos', mapped: 1, missing: [], unresolvable: [], unusedClassIds: [] });
    expect(mapped.warnings).toEqual([]);
  });

  it('requireMapping refuses with DAT_HANDOVER_MAPPING_MISSING and the list of classes', () => {
    const refused = expectRefusal(
      sc01,
      'export_handover',
      { profile: 'cfihos-subset', requireMapping: true },
      'DAT_HANDOVER_MAPPING_MISSING',
      'requireMapping',
    );
    expect(refused.summary).toContain('CentrifugalPump');
  });

  it('is byte-deterministic: the same document gives the same files, twice', () => {
    const again = handover(scDat01Document(), { profile: 'cfihos-subset' });
    expect(again.files.map((file) => file.content)).toEqual(result.files.map((file) => file.content));
    expect(JSON.stringify(handover(sc01, { profile: 'cfihos-subset' }))).toBe(JSON.stringify(result));
  });

  it('is pure: the document is not mutated', () => {
    const before = JSON.stringify(sc01);
    handover(sc01, { profile: 'cfihos-subset' });
    expect(JSON.stringify(sc01)).toBe(before);
  });
});

describe('export_handover generic and the other registers', () => {
  it('generic is not marked, uses llull names, and registers can be a subset', () => {
    const result = handover(sc01, { profile: 'generic', registers: ['equipment_register'] });
    expect(result.unverified).toBe(false);
    expect(result.files.map((file) => file.fileName)).toEqual(['generic-equipment-register.csv', 'handover-manifest.json']);
    expect(result.registers['equipment_register']?.columns).toEqual(['Tag', 'Manufacturer', 'Model', 'SerialNumber']);
    expect(result.registers['equipment_register']?.rows.map((row) => row['Tag'])).toEqual(['P-101', 'T-101']);
    expect(execute(sc01, 'export_handover', { profile: 'generic' }).summary).not.toContain('UNVERIFIED');
  });

  it('equipment_register reads Manufacturer, Model and SerialNumber properties when a class defines them', () => {
    let doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'DatasheetPump',
      parent: 'CentrifugalPump',
      properties: [
        { name: 'Model', type: 'text' },
        { name: 'SerialNumber', type: 'text' },
      ],
    });
    doc = assignPump(addEquipment(doc, { name: 'D' }).doc, 'equipment-1', {
      className: 'DatasheetPump',
      properties: { Description: 'd', DesignPressure: 4, Manufacturer: 'Acme', Model: 'M-9', SerialNumber: 'SN-123' },
    }).doc;
    const rows = handover(doc, { profile: 'generic', registers: ['equipment_register'] }).registers['equipment_register']?.rows;
    expect(rows).toEqual([{ Tag: expect.any(String), Manufacturer: 'Acme', Model: 'M-9', SerialNumber: 'SN-123' }]);
  });

  it('tag_properties has one row per stored value with unit and the unverified flag from the provenance', () => {
    const doc = assignPump(addEquipment(libraryDocument(), { name: 'U' }).doc, 'equipment-1', {
      provenance: { DesignPressure: { source: 'datasheet', unverified: true } },
    }).doc;
    const rows = handover(doc, { profile: 'generic', registers: ['tag_properties'] }).registers['tag_properties']?.rows ?? [];
    expect(rows.find((row) => row['Property'] === 'DesignPressure')).toMatchObject({ Value: 10, Unit: 'barg', Unverified: true });
    expect(rows.find((row) => row['Property'] === 'Description')).toMatchObject({ Value: 'A pump', Unit: '', Unverified: false });
    expect(rows.every((row) => row['Value'] !== null)).toBe(true);
  });

  it('a reserved tag, an orphan and a nozzle-free pump give their status and a parent tag for a line member', () => {
    let doc = apply(libraryDocument(), 'assign_plant_object', {
      target: 'reserved',
      className: 'Tank',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'later', DesignPressure: 2 },
    });
    const pump = assignPump(addEquipment(doc, { name: 'O' }).doc, 'equipment-1');
    doc = pump.doc;
    const line = apply(doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { fluidCode: 'CWS', seq: 1, spec: 'B2' },
      properties: { nominalSize: 50 },
    });
    const owner = getPlantData(line).objectOrder.at(-1) as string;
    const member = apply(line, 'set_plant_properties', {
      edits: [{ object: pump.objectId, property: 'Description', value: 'on the line' }],
    });
    const withMember = {
      ...member,
      plant: {
        ...member.plant,
        data: {
          ...getPlantData(member),
          objects: { ...getPlantData(member).objects, [pump.objectId]: { ...getPlantData(member).objects[pump.objectId]!, lineId: owner } },
        },
      },
    } as CadDocument;
    const rows = handover(withMember, { profile: 'generic', registers: ['tag_register'] }).registers['tag_register']?.rows ?? [];
    expect(rows.map((row) => row['Status'])).toContain('reserved');
    const lineTag = getPlantData(withMember).objects[owner]?.tag;
    expect(rows.find((row) => row['Description'] === 'on the line')?.['ParentTag']).toBe(lineTag);
  });

  it('hierarchy restricts the tag registers; an unknown node is refused', () => {
    const pumped = assignPump(addEquipment(libraryDocument(), { name: 'H' }).doc, 'equipment-1').doc;
    const rowsAt = (hierarchy: string): Array<Record<string, unknown>> =>
      handover(pumped, { profile: 'generic', registers: ['tag_register'], hierarchy }).registers['tag_register']?.rows ?? [];
    expect(rowsAt('P2')).toEqual([]);
    expect(rowsAt('U10')).toHaveLength(1);
    expectRefusal(sc01, 'export_handover', { profile: 'generic', hierarchy: 'ZZ' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
  });

  it('refuses a bad profile or register (schema) with the document unchanged', () => {
    for (const params of [{}, { profile: 'cfihos' }, { profile: 'generic', registers: [] }, { profile: 'generic', registers: ['nope'] }]) {
      const result = execute(sc01, 'export_handover', params);
      expect(result.rejected, JSON.stringify(params)).toBe(true);
      expect(result.document).toBe(sc01);
    }
  });
});

describe('document register', () => {
  const review = (doc: CadDocument, deliverable: string, revision: string, status = 'issued_for_review'): CommandResult =>
    execute(doc, 'set_deliverable_status', { at: AT, deliverable, revision, status });
  const registerOf = (doc: CadDocument): Array<Record<string, unknown>> =>
    handover(doc, { profile: 'generic', registers: ['document_register'] }).registers['document_register']?.rows ?? [];

  it('lists every revision with its current status and whether the content still hashes to the stored value', () => {
    const reviewed = review(sc01, 'tag_register', 'A');
    const both = review(reviewed.document, 'ifc', 'A', 'in_work').document;
    const rows = registerOf(both);
    expect(rows.map((row) => `${row['Deliverable']}/${row['Revision']}/${row['Status']}`)).toEqual([
      'ifc/A/in_work',
      'tag_register/A/issued_for_review',
    ]);
    expect(rows.every((row) => row['ContentCurrent'] === true)).toBe(true);
    expect(rows.find((row) => row['Deliverable'] === 'tag_register')?.['ContentSha256']).toBe(
      (reviewed.data as { contentSha256: string }).contentSha256,
    );
    const edited = apply(both, 'set_plant_properties', {
      edits: [{ object: getPlantData(sc01).objectOrder[0], property: 'Description', value: 'moved on' }],
    });
    expect(registerOf(edited).find((row) => row['Deliverable'] === 'ifc')?.['ContentCurrent']).toBe(false);
  });

  it('a superseded revision has an empty ContentCurrent', () => {
    const rows = registerOf(review(review(sc01, 'tag_register', 'A').document, 'tag_register', 'B').document);
    expect(rows.map((row) => [row['Revision'], row['Status'], row['ContentCurrent']])).toEqual([
      ['A', 'superseded', ''],
      ['B', 'issued_for_review', true],
    ]);
  });
});

describe('the export gate and define_plant_class externalIds', () => {
  const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'ITAR' } };

  it('a controlled document is refused without the human confirmation', () => {
    const doc = boxOf(step(sc01, 'define_material_record', record), 'secret').doc;
    expectRefusal(doc, 'export_handover', { profile: 'generic' }, 'MAT_EXPORT_CONTROLLED');
    expectRefusal(doc, 'export_handover', { profile: 'generic', confirmExportControlled: true }, 'MAT_HUMAN_GATE');
  });

  it('externalIds: stored on the class, one per scheme (a repeat is refused); a hand-edited file with a bad entry is refused', () => {
    const doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'MyPump',
      parent: 'CentrifugalPump',
      externalIds: [
        { scheme: 'cfihos', id: 'C-1' },
        { scheme: 'company', id: 'M' },
      ],
    });
    expect(getPlantData(doc).classes['MyPump']?.externalIds).toEqual([
      { scheme: 'cfihos', id: 'C-1' },
      { scheme: 'company', id: 'M' },
    ]);
    const twice = [
      { scheme: 'cfihos', id: 'a' },
      { scheme: 'cfihos', id: 'b' },
    ];
    expectRefusal(libraryDocument(), 'define_plant_class', { name: 'Dup', externalIds: twice }, 'DAT_PARAM_INVALID', 'externalIds');
    const file = JSON.parse(JSON.stringify(getPlantData(doc))) as { classes: Record<string, { externalIds: unknown }> };
    expect(plantDataErrors(file)).toEqual([]);
    for (const bad of [[{ scheme: 'x', id: 'a' }], twice, [{ scheme: 'cfihos', id: '' }], 'cfihos']) {
      file.classes['MyPump']!.externalIds = bad;
      expect(plantDataErrors(file), JSON.stringify(bad)).toEqual([expect.stringContaining('externalIds')]);
    }
  });
});

describe('class id mapping report', () => {
  it('mapped counts only classes with an id; an unresolvable class is listed; unused classIds are warned; the manifest records each id source', () => {
    const own = apply(libraryDocument(), 'define_plant_class', {
      name: 'FeedPump',
      parent: 'CentrifugalPump',
      externalIds: [{ scheme: 'cfihos', id: 'C-77' }],
    });
    let doc = assignPump(addEquipment(own, { name: 'F' }).doc, 'equipment-1', { className: 'FeedPump' }).doc;
    doc = assignPump(addEquipment(doc, { name: 'G' }).doc, 'equipment-2').doc;
    doc = withData(doc, (current) => {
      const ghost = { ...current.objects[current.objectOrder[0] as string]!, id: 'plantobj-ghost', className: 'Ghost', tag: 'GHOST-1' };
      return { ...current, objects: { ...current.objects, [ghost.id]: ghost }, objectOrder: [...current.objectOrder, ghost.id] };
    });
    const result = handover(doc, { profile: 'cfihos-subset', classIds: { CentrifugalPump: 'X-PUMP', Typo: 'T-1' } });
    expect(result.mapping).toEqual({ scheme: 'cfihos', mapped: 2, missing: [], unresolvable: ['Ghost'], unusedClassIds: ['Typo'] });
    expect(result.warnings.join('\n')).toContain('Typo');
    expect(result.warnings.join('\n')).toContain('Ghost');
    const manifest = JSON.parse(fileOf(result, 'handover-manifest')) as { classIds: Array<{ class: string; id: string; source: string }> };
    expect(manifest.classIds).toEqual([
      { class: 'CentrifugalPump', id: 'X-PUMP', source: 'classIds' },
      { class: 'FeedPump', id: 'C-77', source: 'externalIds' },
    ]);
    const plain = handover(doc, { profile: 'cfihos-subset' });
    expect(plain.mapping.mapped).toBe(1);
    expect(plain.mapping.missing).toEqual(['CentrifugalPump']);
  });

  it('the document register shows when each revision was last stepped (IssuedAt)', () => {
    const reviewed = execute(sc01, 'set_deliverable_status', {
      at: AT,
      deliverable: 'tag_register',
      revision: 'A',
      status: 'issued_for_review',
    });
    const rows = handover(reviewed.document, { profile: 'cfihos-subset', registers: ['document_register'] }).registers['document_register']
      ?.rows;
    expect(rows?.[0]).toMatchObject({ ISSUED_AT: AT, DOCUMENT_ID: 'tag_register' });
  });
});
