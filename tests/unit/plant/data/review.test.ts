/**
 * Plant 08 DAT M1 review fixes: tags are written into the model through the owning commands (`rename_equipment_tag`, `set_pipe_line_number`,
 * `update_pipeline`) so references follow; swaps; colliding tag scopes; orphan re-binding; pattern and format guards.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { getPlantData } from '@aec/plant/data/model';
import { getProvider } from '@aec/plant/data/providers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { addEquipment, addPipe, libraryDocument } from './dataFixtures';

interface Check {
  status: string;
  findings: Array<{ code: string; paths: string[] }>;
}

/** SC-RTE-01 (pump P-101, vessel V-101 with nozzle N1, routed line from P-101:N2 to V-101:N1) + a legacy pipe from V-101:N1 + the plant data library. */
function scene(): { doc: CadDocument; line: string; vessel: string; pipe: string } {
  const base = routedPumpToVessel();
  const withPipe = addPipe(base.doc, { dn: 100, line: 'L-7', from: 'V-101:N1', to: 'BL-1', service: 'process' });
  let doc = apply(withPipe.doc, 'define_plant_hierarchy', {
    nodes: [
      { code: 'S1', kind: 'site' },
      { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
    ],
  });
  doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
  const vessel = Object.values(doc.building?.elements ?? {}).find(
    (element) => element.category === 'equipment' && element.mark === 'V-101',
  );
  return { doc, line: base.line, vessel: vessel?.id as string, pipe: withPipe.id };
}

describe('writing a tag renames through the owning commands', () => {
  it('renaming a parametric vessel keeps the nozzle references of the legacy pipe and the routed line, and the check finds no unresolved end', () => {
    const s = scene();
    let doc = apply(s.doc, 'assign_plant_object', {
      target: s.vessel,
      className: 'PressureVessel',
      hierarchy: 'U10',
      tagFields: { seq: 2 },
      properties: { DesignPressure: 10 },
    });
    const vessel = doc.building?.elements[s.vessel];
    expect(vessel?.category === 'equipment' && vessel.mark).toBe('V-102');
    const pipe = doc.building?.elements[s.pipe];
    expect(pipe?.category === 'pipe' && pipe.from).toBe('V-102:N1');
    expect(doc.plant?.piping?.lines[s.line]?.to).toBe('V-102:N1');
    expect(data<{ nozzles?: unknown }>(doc, 'equipment_ports', { equipment: 'V-102' })).toBeDefined();
    doc = apply(doc, 'assign_plant_object', {
      target: 'equipment-1',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
      properties: { DesignPressure: 10 },
    });
    doc = apply(doc, 'assign_plant_object', {
      target: s.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    doc = apply(doc, 'assign_plant_object', {
      target: s.pipe,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { fluidCode: 'P', seq: 7, spec: 'A1' },
    });
    const check = data<Check>(doc, 'check_plant_data', {});
    expect(check.findings.filter((finding) => finding.code === 'DAT_LINE_END_UNRESOLVED')).toEqual([]);
    expect(check.status).toBe('pass');
    expect(data<{ counts: unknown }>(doc, 'piping_takeoff', {})).toBeDefined();
  });

  it('refuses a tag format that generates an illegal equipment tag (whitespace or a colon) and writes nothing', () => {
    const s = scene();
    for (const format of ['{classCode} {seq:3}', '{hierarchy.unit.code}:{seq:2}']) {
      const doc = apply(s.doc, 'define_plant_class', { name: `Odd${format.length}`, parent: 'CentrifugalPump', tagFormat: format });
      const refusal = expectRefusal(
        doc,
        'assign_plant_object',
        {
          target: 'equipment-1',
          className: `Odd${format.length}`,
          hierarchy: 'U10',
          tagFields: { seq: 1 },
          properties: { DesignPressure: 1 },
        },
        'DAT_TAG_FORMAT',
        'tag',
      );
      expect(refusal.summary).toContain('whitespace');
    }
  });

  it('a retag that would produce an illegal equipment tag is refused whole', () => {
    const s = scene();
    const doc = apply(apply(s.doc, 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' }), 'assign_plant_object', {
      target: 'equipment-1',
      className: 'MyPump',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
      properties: { DesignPressure: 1 },
    });
    expectRefusal(doc, 'set_tag_format', { className: 'MyPump', tagFormat: '{classCode} {seq:3}', retag: true }, 'DAT_TAG_FORMAT');
  });

  it('swapping two equipment tags in one batch is valid, and so is swapping two routed line numbers', () => {
    const s = scene();
    const swapped = ok(s.doc, 'rename_equipment_tag', {
      renames: [
        { equipment: 'V-101', tag: 'P-101' },
        { equipment: 'P-101', tag: 'V-101' },
      ],
    });
    expect(swapped.data).toMatchObject({
      renamed: [expect.objectContaining({ from: 'P-101', to: 'V-101' }), expect.objectContaining({ from: 'V-101', to: 'P-101' })],
    });
    expect((swapped.data as { pipes: string[] }).pipes).toEqual([s.pipe]);
    expect(data<{ lines: string[] }>(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'X-1' }] }).lines).toEqual([
      s.line,
    ]);
  });

  it('rename_equipment_tag refuses unknown equipment, bad grammar and duplicates; nothing changes', () => {
    const s = scene();
    expectRefusal(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'NOPE', tag: 'X-1' }] }, 'EQP_NOT_FOUND', 'renames[0].equipment');
    expectRefusal(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'X 1' }] }, 'EQP_PARAM_INVALID', 'renames[0].tag');
    expectRefusal(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'a:b' }] }, 'EQP_PARAM_INVALID', 'renames[0].tag');
    expectRefusal(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'P-101' }] }, 'EQP_TAG_DUPLICATE', 'renames');
    const same = execute(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'V-101' }] });
    expect(same.document).toBe(s.doc);
    const before = structuredClone(s.doc);
    execute(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'V-9' }] });
    expect(s.doc).toEqual(before);
  });

  it('set_pipe_line_number renumbers legacy pipes, allows shared numbers, refuses routed numbers and unknown pipes', () => {
    const s = scene();
    const changed = ok(s.doc, 'set_pipe_line_number', { pipes: [{ pipeId: s.pipe, line: 'L-8' }] });
    expect(changed.data).toEqual({ changed: [{ id: s.pipe, from: 'L-7', to: 'L-8' }] });
    const routedNumber = s.doc.plant?.piping?.lines[s.line]?.lineNumber as string;
    expectRefusal(
      s.doc,
      'set_pipe_line_number',
      { pipes: [{ pipeId: s.pipe, line: routedNumber }] },
      'RTE_DUPLICATE_LINE_NUMBER',
      'pipes[0].line',
    );
    expectRefusal(s.doc, 'set_pipe_line_number', { pipes: [{ pipeId: 'pipe-99', line: 'X' }] }, 'RTE_UNKNOWN_PIPE', 'pipes[0].pipeId');
    expectRefusal(s.doc, 'set_pipe_line_number', { pipes: [{ pipeId: s.pipe, line: ' ' }] }, 'RTE_EDIT_INVALID', 'pipes[0].line');
    expect(execute(s.doc, 'set_pipe_line_number', { pipes: [{ pipeId: s.pipe, line: 'L-7' }] }).document).toBe(s.doc);
  });

  it('two routed lines swap their numbers through temporary numbers', () => {
    const base = routedPumpToVessel();
    const second = apply(base.doc, 'create_pipeline', { service: 'P', sequence: '2002', spec: 'CS150', dn: 100 });
    const secondId = second.plant?.piping?.lineOrder.at(-1) as string;
    const [a, b] = [second.plant?.piping?.lines[base.line]?.lineNumber, second.plant?.piping?.lines[secondId]?.lineNumber] as [
      string,
      string,
    ];
    const written = getProvider('pipeLine')?.writeTags?.(
      second,
      [
        { id: base.line, tag: b },
        { id: secondId, tag: a },
      ],
      undefined,
    );
    expect(typeof written).not.toBe('string');
    const lines = (written as CadDocument).plant?.piping?.lines;
    expect([lines?.[base.line]?.lineNumber, lines?.[secondId]?.lineNumber]).toEqual([b, a]);
  });
});

describe('colliding tag scopes, orphans, patterns and formats', () => {
  it('a project-scoped tag collides with the same tag in a plant, and the reverse; disjoint plants do not collide', () => {
    let doc = apply(libraryDocument(), 'define_plant_hierarchy', {
      nodes: [{ code: 'U20', kind: 'unit', parent: 'P2', properties: { areaNumber: '1' } }],
    });
    doc = apply(doc, 'define_plant_class', { name: 'SitePump', parent: 'CentrifugalPump', tagScope: 'project' });
    const params = { target: 'reserved', hierarchy: 'U10', tagFields: { seq: 1 }, properties: { Description: 'x', DesignPressure: 1 } };
    const plantFirst = apply(doc, 'assign_plant_object', { ...params, className: 'CentrifugalPump' });
    const clash = expectRefusal(
      plantFirst,
      'assign_plant_object',
      { ...params, className: 'SitePump', hierarchy: 'U20' },
      'DAT_TAG_DUPLICATE',
      'tag',
    );
    expect(clash.error?.ids).toHaveLength(1);
    const projectFirst = apply(doc, 'assign_plant_object', { ...params, className: 'SitePump' });
    expectRefusal(projectFirst, 'assign_plant_object', { ...params, className: 'CentrifugalPump', hierarchy: 'U20' }, 'DAT_TAG_DUPLICATE');
    const disjoint = apply(plantFirst, 'assign_plant_object', { ...params, className: 'CentrifugalPump', hierarchy: 'U20' });
    expect(Object.values(getPlantData(disjoint).objects)).toHaveLength(2);
  });

  it('a site-scoped class collides with the plants below its site, and a hand-edited collision is a check failure', () => {
    let doc = apply(libraryDocument(), 'define_plant_class', { name: 'SiteTank', parent: 'Tank', tagScope: 'site' });
    const params = { target: 'reserved', hierarchy: 'U10', tagFields: { seq: 1 }, properties: { Description: 'x', DesignPressure: 1 } };
    doc = apply(doc, 'assign_plant_object', { ...params, className: 'Tank' });
    expectRefusal(doc, 'assign_plant_object', { ...params, className: 'SiteTank' }, 'DAT_TAG_DUPLICATE');
  });

  it('an orphan keeps its tag; modelling the equipment again re-binds it instead of failing with a duplicate', () => {
    const first = addEquipment(libraryDocument(), { name: 'Pump A' });
    const tagged = apply(first.doc, 'assign_plant_object', {
      target: first.id,
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
      properties: { Description: 'A', DesignPressure: 5 },
    });
    const objectId = getPlantData(tagged).objectOrder[0] as string;
    const orphaned = apply(tagged, 'delete_building_element', { elementIds: [first.id] });
    expect(data<Check>(orphaned, 'check_plant_data', {}).findings[0]?.code).toBe('DAT_OBJECT_ORPHAN');
    const again = addEquipment(orphaned, { name: 'Pump A again' });
    const rebound = execute(again.doc, 'assign_plant_object', {
      target: again.id,
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
    });
    expect(rebound.rejected, rebound.summary).toBeUndefined();
    expect(rebound.data).toMatchObject({ objectId, tag: 'P-101', rebound: true });
    const object = getPlantData(rebound.document).objects[objectId];
    expect(object?.target).toEqual({ kind: 'buildingElement', id: again.id });
    expect(object?.properties).toMatchObject({ Description: 'A', DesignPressure: 5 });
    expect(getPlantData(rebound.document).objectOrder).toEqual([objectId]);
    expect(data<Check>(rebound.document, 'check_plant_data', {}).status).toBe('pass');
    // A live object is still a duplicate, and a different class does not take the orphan over.
    const other = addEquipment(rebound.document, { name: 'B' });
    expectRefusal(
      other.doc,
      'assign_plant_object',
      { target: other.id, className: 'CentrifugalPump', hierarchy: 'U10', tagFields: { seq: 1 } },
      'DAT_TAG_DUPLICATE',
    );
    const gone = apply(orphaned, 'define_plant_class', { name: 'MyPump', parent: 'CentrifugalPump' });
    const third = addEquipment(gone, { name: 'C' });
    expectRefusal(
      third.doc,
      'assign_plant_object',
      { target: third.id, className: 'MyPump', hierarchy: 'U10', tagFields: { seq: 1 } },
      'DAT_TAG_DUPLICATE',
    );
  });

  it('refuses capture groups in a property pattern (they would shift the tag field captures)', () => {
    const refusal = expectRefusal(
      libraryDocument(),
      'define_plant_class',
      { name: 'Odd', properties: [{ name: 'Code', type: 'text', pattern: '(A|B)[0-9]' }] },
      'DAT_PROPERTY_DEFINITION_INVALID',
      'properties[0]',
    );
    expect(refusal.summary).toContain('capture groups');
    apply(libraryDocument(), 'define_plant_class', { name: 'Fine', properties: [{ name: 'Code', type: 'text', pattern: '(?:A|B)[0-9]' }] });
  });

  it('refuses a format with two adjacent unpadded fields and reads a free field that contains the separator', () => {
    const doc = libraryDocument();
    expectRefusal(doc, 'define_plant_class', { name: 'Odd', tagFormat: '{a}{b}' }, 'DAT_TAG_FORMAT_INVALID', 'tagFormat');
    const withClass = apply(doc, 'define_plant_class', {
      name: 'Coded',
      tagFormat: '{code}-{seq:4}',
      properties: [{ name: 'code', type: 'text' }],
    });
    const assigned = apply(withClass, 'assign_plant_object', {
      target: 'reserved',
      className: 'Coded',
      hierarchy: 'U10',
      tag: 'HC-1-0007',
    });
    expect(Object.values(getPlantData(assigned).objects)[0]).toMatchObject({
      tag: 'HC-1-0007',
      properties: { code: 'HC-1' },
      tagFields: { seq: 7 },
    });
  });

  it('refuses a subclass whose merged definition is invalid (an inherited default outside the narrowed enum)', () => {
    const doc = apply(libraryDocument(), 'define_plant_class', {
      name: 'Base',
      abstract: true,
      properties: [{ name: 'Kind', type: 'enum', enumValues: ['a', 'b'], default: 'b' }],
    });
    expectRefusal(
      doc,
      'define_plant_class',
      { name: 'Narrow', parent: 'Base', properties: [{ name: 'Kind', type: 'enum', enumValues: ['a'] }] },
      'DAT_PROPERTY_DEFINITION_INVALID',
      'properties',
    );
  });
});
