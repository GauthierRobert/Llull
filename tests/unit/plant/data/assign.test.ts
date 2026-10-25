/**
 * Plant 08 DAT M1: `assign_plant_object` (TR-DAT-06, 07; VC-DAT-01, 02): generated and typed tags, the registry scope rule with holder ids and the next
 * free tag, write-back into the existing tag fields of the model (equipment mark, legacy pipe line number, routed line number), model facts as defaults.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { getPlantData } from '@aec/plant/data/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Line } from '../piping/rteFixtures';
import { addEquipment, addPipe, assignPump, libraryDocument } from './dataFixtures';

interface Assigned {
  objectId: string;
  tag: string;
  className: string;
  hierarchy: string;
  scope: string;
  seeded: string[];
  tagWritten: boolean;
}

const pumpParams = (target: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  target,
  className: 'CentrifugalPump',
  hierarchy: 'U10',
  tagFields: { seq: 1 },
  properties: { Description: 'Transfer pump', DesignPressure: 16 },
  ...extra,
});

describe('assign_plant_object: the tag is generated from the class format, the fields and the hierarchy', () => {
  it('builds P-101 from the class code P, the unit areaNumber 1 and seq 1, and writes it into the equipment mark', () => {
    const base = addEquipment(libraryDocument());
    const result = ok(base.doc, 'assign_plant_object', pumpParams(base.id));
    const assigned = result.data as Assigned;
    expect(assigned).toMatchObject({ tag: 'P-101', className: 'CentrifugalPump', hierarchy: 'S1/P1/U10', tagWritten: true });
    expect(result.affected).toEqual([assigned.objectId, base.id]);
    const element = result.document.building?.elements[base.id];
    expect(element?.mark).toBe('P-101');
    const object = getPlantData(result.document).objects[assigned.objectId];
    expect(object).toMatchObject({ tag: 'P-101', target: { kind: 'buildingElement', id: base.id }, tagFields: { seq: 1 } });
    expect(getPlantData(result.document).objectOrder).toEqual([assigned.objectId]);
    expect(assigned.objectId).toMatch(/^plantobj-\d+\.\d+$/);
  });

  it('takes the equipment name and operating weight from the model as defaults, flagged in the provenance, and lets the caller win', () => {
    const base = addEquipment(libraryDocument(), { name: 'Feed pump', weight: 450 });
    const assigned = data<Assigned>(base.doc, 'assign_plant_object', { ...pumpParams(base.id), properties: { DesignPressure: 16 } });
    expect(assigned.seeded.sort()).toEqual(['Description', 'OperatingWeight']);
    const next = apply(base.doc, 'assign_plant_object', {
      ...pumpParams(base.id),
      properties: { DesignPressure: 16, Description: 'Mine' },
    });
    const object = Object.values(getPlantData(next).objects)[0];
    expect(object?.properties).toMatchObject({ Description: 'Mine', OperatingWeight: 450, DesignPressure: 16 });
    expect(object?.provenance?.['OperatingWeight']).toEqual({ source: 'default', ref: `model:buildingElement:${base.id}` });
    expect(object?.provenance?.['Description']).toBeUndefined();
  });

  it('nextSequence takes max + 1 among the tags with the same other fields, never reusing a gap', () => {
    let doc = libraryDocument();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const added = addEquipment(doc, { name: `Pump ${index}` });
      doc = added.doc;
      ids.push(added.id);
    }
    doc = assignPump(doc, ids[0] as string).doc;
    doc = assignPump(doc, ids[1] as string).doc;
    doc = apply(doc, 'unassign_plant_object', { objects: ['P-101'] });
    const third = data<Assigned>(doc, 'assign_plant_object', pumpParams(ids[2] as string, { tagFields: undefined, nextSequence: true }));
    expect(third.tag).toBe('P-103');
  });

  it('accepts a typed tag that matches the format and reads its fields back', () => {
    const base = addEquipment(libraryDocument());
    const result = ok(base.doc, 'assign_plant_object', pumpParams(base.id, { tagFields: undefined, tag: 'P-107' }));
    expect(Object.values(getPlantData(result.document).objects)[0]?.tagFields).toEqual({ seq: 7 });
  });

  it('holds a tag before its object exists with a reserved target', () => {
    const doc = libraryDocument();
    const result = ok(
      doc,
      'assign_plant_object',
      pumpParams('reserved', { properties: { Description: 'Future pump', DesignPressure: 12 } }),
    );
    const object = Object.values(getPlantData(result.document).objects)[0];
    expect(object?.target).toEqual({ kind: 'reserved' });
    expect(object?.tag).toBe('P-101');
  });

  it('classifies a legacy pipe: the line number is written into the pipe and the size is a default', () => {
    const base = addPipe(libraryDocument(), { line: 'L-1', service: 'cooling water' });
    const result = ok(base.doc, 'assign_plant_object', {
      target: base.id,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { fluidCode: 'CWS', seq: 7, spec: 'B2' },
    });
    expect((result.data as Assigned).tag).toBe('50-CWS-0007-B2');
    const pipe = result.document.building?.elements[base.id];
    expect(pipe?.category === 'pipe' && pipe.line).toBe('50-CWS-0007-B2');
    expect(Object.values(getPlantData(result.document).objects)[0]?.properties['nominalSize']).toBe(50);
  });

  it('classifies a routed line from the RTE template: the fields come from the line, the number is written through update_pipeline', () => {
    const { doc, lineId } = cs150Line(100, '1001');
    const withLibrary = apply(
      apply(doc, 'define_plant_hierarchy', {
        nodes: [
          { code: 'S1', kind: 'site' },
          { code: 'U1', kind: 'unit', parent: 'S1' },
        ],
      }),
      'load_plant_class_library',
      { library: 'llull-default-process' },
    );
    const before = withLibrary.plant?.piping?.lines[lineId]?.lineNumber;
    const result = ok(withLibrary, 'assign_plant_object', {
      target: lineId,
      className: 'ProcessLine',
      hierarchy: 'U1',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    const assigned = result.data as Assigned;
    expect(assigned.tag).toBe('100-P-1001-CS150');
    expect(assigned.seeded).toEqual(expect.arrayContaining(['nominalSize']));
    expect(result.document.plant?.piping?.lines[lineId]?.lineNumber).toBe('100-P-1001-CS150');
    expect(before).toBeDefined();
    expect(result.document.featureHistory.at(-1)?.name).toBe('assign_plant_object');
  });

  it('is pure: the input document is untouched, and a second run gives an identical result', () => {
    const base = addEquipment(libraryDocument());
    const before = structuredClone(base.doc);
    const first = execute(base.doc, 'assign_plant_object', pumpParams(base.id));
    expect(base.doc).toEqual(before);
    expect(execute(base.doc, 'assign_plant_object', pumpParams(base.id)).document).toEqual(first.document);
  });
});

describe('assign_plant_object: refusals leave the document unchanged and carry a stable code', () => {
  const setup = (): { doc: ReturnType<typeof libraryDocument>; id: string } => {
    const base = addEquipment(libraryDocument());
    return { doc: base.doc, id: base.id };
  };

  it.each([
    ['DAT_CLASS_UNKNOWN', { className: 'Nope' }, 'className'],
    ['DAT_CLASS_ABSTRACT', { className: 'Equipment' }, 'className'],
    ['DAT_HIERARCHY_UNKNOWN', { hierarchy: 'U99' }, 'hierarchy'],
    ['DAT_TARGET_UNKNOWN', { target: 'equipment-99' }, 'target'],
    ['DAT_TAG_FIELD_MISSING', { tagFields: {} }, 'tagFields.seq'],
    ['DAT_TAG_FORMAT', { tagFields: undefined, tag: 'P-1011' }, 'tag'],
    ['DAT_PROPERTY_UNKNOWN', { properties: { Colour: 'red' } }, 'properties.Colour'],
    ['DAT_PROPERTY_TYPE', { properties: { DesignPressure: 'high' } }, 'properties.DesignPressure'],
    ['DAT_PROPERTY_UNIT', { properties: { DesignPressure: { value: 10, unit: 'bara' } } }, 'properties.DesignPressure'],
    ['DAT_OBJECT_UNKNOWN', { line: 'L-404' }, 'line'],
  ])('%s', (code, change, path) => {
    const { doc, id } = setup();
    const params = pumpParams(change['target' as keyof typeof change] === undefined ? id : (change as { target: string }).target, change);
    expectRefusal(doc, 'assign_plant_object', params, code, path);
  });

  it('refuses a duplicate tag with the holder id and the next free tag, also across a hand-typed tag', () => {
    const first = assignPump(addEquipment(libraryDocument()).doc, 'equipment-1', {});
    const second = addEquipment(first.doc, { name: 'Pump B' });
    const refusal = expectRefusal(second.doc, 'assign_plant_object', pumpParams(second.id), 'DAT_TAG_DUPLICATE', 'tag');
    expect(refusal.error?.ids).toEqual([first.objectId]);
    expect(refusal.error?.detail).toEqual({ nextFreeTag: 'P-102' });
    expect(refusal.summary).toContain('P-102');
    expectRefusal(second.doc, 'assign_plant_object', pumpParams(second.id, { tagFields: undefined, tag: 'P-101' }), 'DAT_TAG_DUPLICATE');
  });

  it('refuses a tag that another equipment already carries as its mark (one tag system)', () => {
    const first = addEquipment(libraryDocument(), { mark: 'P-101' });
    const second = addEquipment(first.doc, { name: 'Pump B' });
    const refusal = expectRefusal(second.doc, 'assign_plant_object', pumpParams(second.id), 'DAT_TAG_DUPLICATE', 'tag');
    expect(refusal.error?.ids).toEqual([first.id]);
    expect(refusal.error?.detail).toEqual({ nextFreeTag: 'P-102' });
  });

  it('allows the same tag in two plants (the scope is the plant) and refuses it with the project scope', () => {
    const doc = apply(libraryDocument(), 'define_plant_hierarchy', {
      nodes: [{ code: 'U20', kind: 'unit', parent: 'P2', properties: { areaNumber: '1' } }],
    });
    const a = ok(doc, 'assign_plant_object', pumpParams('reserved'));
    const b = ok(a.document, 'assign_plant_object', pumpParams('reserved', { hierarchy: 'U20' }));
    expect((b.data as Assigned).tag).toBe('P-101');
    const project = apply(doc, 'define_plant_class', { name: 'SitePump', parent: 'CentrifugalPump', tagScope: 'project' });
    const c = apply(project, 'assign_plant_object', pumpParams('reserved', { className: 'SitePump' }));
    expectRefusal(c, 'assign_plant_object', pumpParams('reserved', { className: 'SitePump', hierarchy: 'U20' }), 'DAT_TAG_DUPLICATE');
  });

  it('refuses a second plant object on the same target', () => {
    const first = assignPump(addEquipment(libraryDocument()).doc, 'equipment-1');
    const refusal = expectRefusal(
      first.doc,
      'assign_plant_object',
      pumpParams('equipment-1', { tagFields: { seq: 2 } }),
      'DAT_TARGET_ALREADY_TAGGED',
      'target',
    );
    expect(refusal.error?.ids).toEqual([first.objectId]);
  });

  it('refuses nextSequence together with an explicit sequence', () => {
    const { doc, id } = setup();
    expectRefusal(doc, 'assign_plant_object', pumpParams(id, { nextSequence: true }), 'DAT_PARAM_INVALID', 'nextSequence');
  });

  it('refuses a read-only provider that cannot rename its object (an inline component)', () => {
    const doc = libraryDocument();
    expectRefusal(
      doc,
      'assign_plant_object',
      { ...pumpParams('reserved'), target: { provider: 'nope', id: 'x' } },
      'DAT_TARGET_UNKNOWN',
      'target',
    );
  });
});
