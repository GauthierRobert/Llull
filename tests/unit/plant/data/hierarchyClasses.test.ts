/**
 * Plant 08 DAT M1: `define_plant_hierarchy`, `define_plant_class`, `load_plant_class_library`, `set_tag_format` (TR-DAT-03, 04, 09). The IFC mapping table of the
 * default library is compared with the schema facts of the validation pack so the two cannot drift.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { resolvedOrNull } from '@aec/plant/data/classes';
import { DEFAULT_PROCESS_CLASSES } from '@aec/plant/data/library/process';
import { IFC_PREDEFINED_TYPES, ifcMappingProblem } from '@aec/plant/data/ifcMapping';
import { getPlantData } from '@aec/plant/data/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addEquipment, assignPump, hierarchyDocument, libraryDocument, packJson } from './dataFixtures';

describe('define_plant_hierarchy', () => {
  it('creates the nodes in order with step-scoped ids and resolves codes, paths and ids', () => {
    const result = ok(createEmptyDocument(), 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'P1', kind: 'plant', parent: 'S1', name: 'Plant one' },
        { code: 'A', kind: 'area', parent: 'P1' },
        { code: 'U10', kind: 'unit', parent: 'S1/P1/A', properties: { areaNumber: '1' } },
        { code: 'SYS1', kind: 'system', parent: 'U10' },
      ],
    });
    const nodes = (result.data as { nodes: Array<{ id: string; path: string }> }).nodes;
    expect(nodes.map((node) => node.path)).toEqual(['S1', 'S1/P1', 'S1/P1/A', 'S1/P1/A/U10', 'S1/P1/A/U10/SYS1']);
    expect(nodes[0]?.id).toMatch(/^hier-\d+\.1$/);
    expect(result.affected).toEqual(nodes.map((node) => node.id));
    expect(getPlantData(result.document).hierarchy[nodes[1]?.id as string]?.name).toBe('Plant one');
  });

  it('allows a unit directly under a plant, a code repeated under another parent (addressed by path), and replace without objects', () => {
    const doc = apply(libraryDocument(), 'define_plant_hierarchy', {
      nodes: [{ code: 'U10', kind: 'unit', parent: 'P2', properties: { areaNumber: '2' } }],
    });
    const params = { target: 'reserved', className: 'Tank', nextSequence: true };
    const ambiguous = expectRefusal(doc, 'assign_plant_object', { ...params, hierarchy: 'U10' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
    expect(ambiguous.summary).toContain('S1/P1/U10');
    expect(data<{ tag: string }>(doc, 'assign_plant_object', { ...params, hierarchy: 'S1/P2/U10' }).tag).toBe('T-201');
    const replaced = apply(doc, 'define_plant_hierarchy', { replace: true, nodes: [{ code: 'S9', kind: 'site' }] });
    expect(Object.values(getPlantData(replaced).hierarchy).map((node) => node.code)).toEqual(['S9']);
  });

  it.each([
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'P1', kind: 'plant', parent: 'S9' }] }, 'nodes[0].parent'],
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'P1', kind: 'plant' }] }, 'nodes[0].parent'],
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'S2', kind: 'site', parent: 'S1' }] }, 'nodes[0].parent'],
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'A1', kind: 'area', parent: 'S1/P1/U10' }] }, 'nodes[0].kind'],
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'bad/code', kind: 'site' }] }, 'nodes[0].code'],
    ['DAT_HIERARCHY_INVALID', { nodes: [{ code: 'U10', kind: 'unit', parent: 'P' }] }, 'nodes[0].parent'],
    ['DAT_HIERARCHY_DUPLICATE_CODE', { nodes: [{ code: 'U10', kind: 'unit', parent: 'P1' }] }, 'nodes[0].code'],
  ])('refuses %s %#', (code, params, path) => {
    const doc = apply(hierarchyDocument(), 'define_plant_hierarchy', {
      nodes: [
        { code: 'PA', kind: 'plant', parent: 'S1' },
        { code: 'U10', kind: 'unit', parent: 'P2' },
      ],
    });
    expectRefusal(doc, 'define_plant_hierarchy', params, code, path);
  });

  it('refuses replace while plant objects exist, and a failing node later in the batch applies nothing', () => {
    const tagged = assignPump(addEquipment(libraryDocument()).doc, 'equipment-1').doc;
    expectRefusal(
      tagged,
      'define_plant_hierarchy',
      { replace: true, nodes: [{ code: 'S9', kind: 'site' }] },
      'DAT_HIERARCHY_INVALID',
      'replace',
    );
    const base = hierarchyDocument();
    const refused = execute(base, 'define_plant_hierarchy', {
      nodes: [
        { code: 'P3', kind: 'plant', parent: 'S1' },
        { code: 'X', kind: 'unit', parent: 'NOPE' },
      ],
    });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(base);
  });

  it('is pure', () => {
    const doc = hierarchyDocument();
    const before = structuredClone(doc);
    execute(doc, 'define_plant_hierarchy', { nodes: [{ code: 'P3', kind: 'plant', parent: 'S1' }] });
    expect(doc).toEqual(before);
  });
});

describe('load_plant_class_library', () => {
  it('adds the whole default library with its IFC mapping, once', () => {
    const doc = libraryDocument();
    const names = getPlantData(doc).classOrder;
    expect(names).toEqual(DEFAULT_PROCESS_CLASSES.map((cls) => cls.name));
    expect(getPlantData(doc).classes['CentrifugalPump']?.ifc).toEqual({
      entity: 'IfcPump',
      predefinedType: 'ENDSUCTION',
      pset: 'Pset_PumpTypeCommon',
    });
    const again = ok(doc, 'load_plant_class_library', { library: 'llull-default-process' });
    expect(again.document).toBe(doc);
    expect((again.data as { added: string[] }).added).toEqual([]);
  });

  it('adds only the requested classes and their ancestors, and skips what exists', () => {
    const result = ok(hierarchyDocument(), 'load_plant_class_library', { library: 'llull-default-process', classes: ['Tank'] });
    expect((result.data as { added: string[] }).added).toEqual(['Equipment', 'Tank']);
    const more = data<{ added: string[]; skipped: Array<{ name: string }> }>(result.document, 'load_plant_class_library', {
      library: 'llull-default-process',
      classes: ['Tank', 'Column'],
    });
    expect(more.added).toEqual(['Column']);
    expect(more.skipped.map((entry) => entry.name)).toEqual(['Equipment', 'Tank']);
  });

  it('refuses an unknown library and an unknown class', () => {
    expectRefusal(hierarchyDocument(), 'load_plant_class_library', { library: 'nope' }, 'DAT_LIBRARY_UNKNOWN', 'library');
    expectRefusal(
      hierarchyDocument(),
      'load_plant_class_library',
      { library: 'llull-default-process', classes: ['Nope'] },
      'DAT_CLASS_UNKNOWN',
      'classes',
    );
  });

  it('every library class resolves, maps to a valid IFC class and type, and the mapping table equals the schema facts of the pack', () => {
    const model = getPlantData(libraryDocument());
    for (const name of model.classOrder) {
      const resolved = resolvedOrNull(model, name);
      expect(resolved, name).not.toBeNull();
      if (resolved?.ifc !== undefined) expect(ifcMappingProblem(resolved.ifc), name).toBeNull();
    }
    const facts = packJson<{ enumerations: Record<string, string[]> }>('data/reference/ifc4x3_add2_plant_schema_facts.json').enumerations;
    for (const [entity, values] of Object.entries(IFC_PREDEFINED_TYPES)) {
      const listed = facts[`${entity}TypeEnum`];
      if (listed !== undefined) expect([...values].sort(), entity).toEqual([...listed].sort());
    }
  });
});

describe('define_plant_class', () => {
  const define = (doc: ReturnType<typeof libraryDocument>, params: Record<string, unknown>): ReturnType<typeof libraryDocument> =>
    apply(doc, 'define_plant_class', params);

  it('defines a subclass of a library class that inherits its properties, format and mapping and may tighten a property', () => {
    const result = ok(libraryDocument(), 'define_plant_class', {
      name: 'FeedPump',
      parent: 'CentrifugalPump',
      properties: [
        { name: 'Service', type: 'text', required: true },
        { name: 'Head', type: 'length', unit: 'm' },
      ],
    });
    const info = result.data as {
      tagFormat: string;
      classCode: string;
      resolvedProperties: Array<{ name: string; required: boolean; unit: string | null }>;
    };
    expect(info.tagFormat).toBe('{classCode}-{area}{seq:2}');
    expect(info.classCode).toBe('P');
    expect(info.resolvedProperties.find((property) => property.name === 'Service')?.required).toBe(true);
    expect(info.resolvedProperties.find((property) => property.name === 'Head')?.unit).toBe('m');
    expect(info.resolvedProperties.find((property) => property.name === 'DesignPressure')?.unit).toBe('barg');
    expect(resolvedOrNull(getPlantData(result.document), 'FeedPump')?.ifc?.entity).toBe('IfcPump');
    expect(result.affected).toEqual(['FeedPump']);
  });

  it.each([
    ['DAT_CLASS_EXISTS', { name: 'Mine' }, 'name'],
    ['DAT_LIBRARY_CLASS_LOCKED', { name: 'Tank' }, 'name'],
    ['DAT_CLASS_PARENT_UNKNOWN', { name: 'Other', parent: 'Nope' }, 'parent'],
    ['DAT_CLASS_CYCLE', { name: 'Self', parent: 'Self' }, 'parent'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'lower' }, 'name'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', classCode: 'a b' }, 'classCode'],
    ['DAT_TAG_FORMAT_INVALID', { name: 'Other', tagFormat: 'no fields' }, 'tagFormat'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'bad name', type: 'text' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'P', type: 'pressure' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'P', type: 'pressure', unit: 'furlong' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'E', type: 'enum' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'T', type: 'text', unit: 'mm' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'T', type: 'text', pattern: '(' }] }, 'properties[0]'],
    ['DAT_PROPERTY_DEFINITION_INVALID', { name: 'Other', properties: [{ name: 'T', type: 'integer', default: 'x' }] }, 'properties[0]'],
    [
      'DAT_PROPERTY_DEFINITION_INVALID',
      {
        name: 'Other',
        properties: [
          { name: 'T', type: 'text' },
          { name: 'T', type: 'text' },
        ],
      },
      'properties[1].name',
    ],
    ['DAT_IFC_MAPPING_INVALID', { name: 'Other', ifc: { entity: 'IfcNothing' } }, 'ifc'],
    ['DAT_IFC_MAPPING_INVALID', { name: 'Other', ifc: { entity: 'IfcPump', predefinedType: 'CHECK' } }, 'ifc'],
    ['DAT_IFC_MAPPING_INVALID', { name: 'Other', ifc: { entity: 'IfcTank', predefinedType: 'USERDEFINED' } }, 'ifc'],
  ])('refuses %s %#', (code, params, path) => {
    expectRefusal(define(libraryDocument(), { name: 'Mine' }), 'define_plant_class', params, code, path);
  });

  it('a subclass cannot change the type or unit of an inherited property, relax it, widen an enum or replace a pattern', () => {
    let doc = define(libraryDocument(), {
      name: 'Base',
      abstract: true,
      properties: [
        { name: 'Kind', type: 'enum', enumValues: ['a', 'b'], required: true },
        { name: 'Tag2', type: 'text', pattern: '[A-Z]+' },
      ],
    });
    for (const property of [
      { name: 'DesignPressure', type: 'pressure', unit: 'bara' },
      { name: 'DesignPressure', type: 'real' },
      { name: 'Description', type: 'text', required: false },
      { name: 'Kind', type: 'enum', enumValues: ['a', 'c'] },
      { name: 'Tag2', type: 'text', pattern: '[a-z]+' },
      { name: 'Tag2', type: 'text' },
    ])
      expectRefusal(
        doc,
        'define_plant_class',
        { name: 'Child', parent: property.name === 'Kind' || property.name === 'Tag2' ? 'Base' : 'Tank', properties: [property] },
        'DAT_PROPERTY_DEFINITION_INVALID',
        'properties',
      );
    doc = define(doc, { name: 'Narrow', parent: 'Base', properties: [{ name: 'Kind', type: 'enum', enumValues: ['a'], required: true }] });
    expect(resolvedOrNull(getPlantData(doc), 'Narrow')?.properties.find((property) => property.name === 'Kind')?.enumValues).toEqual(['a']);
  });

  it('is pure', () => {
    const doc = libraryDocument();
    const before = structuredClone(doc);
    execute(doc, 'define_plant_class', { name: 'Mine' });
    expect(doc).toEqual(before);
  });
});

describe('set_tag_format', () => {
  const tagged = (): { doc: ReturnType<typeof libraryDocument>; ids: string[] } => {
    let doc = apply(libraryDocument(), 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' });
    const ids: string[] = [];
    for (const name of ['A', 'B']) {
      const added = addEquipment(doc, { name });
      doc = apply(added.doc, 'assign_plant_object', {
        target: added.id,
        className: 'MyPump',
        hierarchy: 'U10',
        nextSequence: true,
        properties: { Description: name, DesignPressure: 5 },
      });
      ids.push(added.id);
    }
    return { doc, ids };
  };

  it('without retag keeps the tags and check_plant_data reports each divergent one', () => {
    const { doc } = tagged();
    const result = ok(doc, 'set_tag_format', { className: 'MyPump', tagFormat: '{classCode}-{area}{seq:3}' });
    expect(result.data).toMatchObject({ divergent: 2, changedTags: [] });
    const check = data<{ status: string; findings: Array<{ code: string }> }>(result.document, 'check_plant_data', {});
    expect(check.status).toBe('fail');
    expect(check.findings.filter((finding) => finding.code === 'DAT_TAG_FORMAT')).toHaveLength(2);
  });

  it('with retag regenerates the tags and writes them into the equipment marks, as one step', () => {
    const { doc, ids } = tagged();
    const result = ok(doc, 'set_tag_format', { className: 'MyPump', tagFormat: '{classCode}-{area}{seq:3}', retag: true });
    expect(
      (result.data as { changedTags: Array<{ from: string; to: string }> }).changedTags.map((change) => `${change.from}>${change.to}`),
    ).toEqual(['P-101>P-1001', 'P-102>P-1002']);
    expect(result.document.building?.elements[ids[0] as string]?.mark).toBe('P-1001');
    expect(data<{ status: string }>(result.document, 'check_plant_data', {}).status).toBe('pass');
  });

  it('refuses a retag that would collide, a missing field, a library class, an unknown class and a bad format', () => {
    const { doc } = tagged();
    expectRefusal(doc, 'set_tag_format', { className: 'MyPump', tagFormat: 'PUMP', retag: true }, 'DAT_TAG_FORMAT_INVALID', 'tagFormat');
    expectRefusal(doc, 'set_tag_format', { className: 'MyPump', tagFormat: 'X-{nope}', retag: true }, 'DAT_TAG_FIELD_MISSING');
    expectRefusal(doc, 'set_tag_format', { className: 'MyPump', tagFormat: 'X-{hierarchy.plant.code}', retag: true }, 'DAT_TAG_DUPLICATE');
    expectRefusal(doc, 'set_tag_format', { className: 'Tank', tagFormat: 'T-{seq}' }, 'DAT_LIBRARY_CLASS_LOCKED', 'className');
    expectRefusal(doc, 'set_tag_format', { className: 'Nope', tagFormat: 'T-{seq}' }, 'DAT_CLASS_UNKNOWN', 'className');
  });

  it('does nothing when the format is already set', () => {
    const { doc } = tagged();
    const same = ok(doc, 'set_tag_format', { className: 'MyPump', tagFormat: '{classCode}-{area}{seq:3}' }).document;
    const result = execute(same, 'set_tag_format', { className: 'MyPump', tagFormat: '{classCode}-{area}{seq:3}' });
    expect(result.document).toBe(same);
    expect(result.rejected).toBeUndefined();
  });
});
