/**
 * Plant 08 DAT-FU (follow-ups of DAT-M1, TECHNICAL_SPEC §13.8): `affected` names the plant objects a rename rewrote, a direct rename of classified
 * equipment is refused (DAT_DIRECT_RENAME), trays / pipe supports / steel members are renamed by `rename_element_tag` and classifiable, and the
 * `mark` clauses of display colour rules follow a rename.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import type { BuildingElement } from '@aec/building/types';
import { renamedReference } from '@aec/plant/equipment/tagReferences';
import { getPlantData } from '@aec/plant/data/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { addEquipment, addPipe, libraryDocument, markEquipmentByHand } from './dataFixtures';

/** SC-RTE-01 + the plant data library; the vessel V-101 and a legacy pipe from V-101:N1 (as in review.test). */
function scene(): { doc: CadDocument; vessel: string; pipe: string } {
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
  return { doc, vessel: vessel?.id as string, pipe: withPipe.id };
}

const vesselParams = (target: string, seq: number): Record<string, unknown> => ({
  target,
  className: 'PressureVessel',
  hierarchy: 'U10',
  tagFields: { seq },
  properties: { DesignPressure: 10 },
});

/** The scene with the legacy pipe classified as a line whose own `from` names V-101:N1. */
function lineAndVessel(): { doc: CadDocument; vessel: string; lineObject: string } {
  const s = scene();
  const doc = apply(s.doc, 'assign_plant_object', {
    target: s.pipe,
    className: 'ProcessLine',
    hierarchy: 'U10',
    tagFields: { fluidCode: 'P', seq: 7, spec: 'A1' },
    properties: { from: 'V-101:N1', to: 'BL-1' },
  });
  return { doc, vessel: s.vessel, lineObject: getPlantData(doc).objectOrder.at(-1) as string };
}

describe('renamedReference (pure)', () => {
  it('replaces the tag of a bare tag or a port id and leaves other text alone', () => {
    const renames = new Map([['V-101', 'V-102']]);
    expect(renamedReference('V-101', renames)).toBe('V-102');
    expect(renamedReference('V-101:N1', renames)).toBe('V-102:N1');
    expect(renamedReference('V-1011:N1', renames)).toBeUndefined();
    expect(renamedReference('BL-1', renames)).toBeUndefined();
    expect(renamedReference(undefined, renames)).toBeUndefined();
  });
});

describe('affected names the plant objects a rename rewrote', () => {
  it('assign_plant_object lists the line object whose from followed the vessel tag', () => {
    const s = lineAndVessel();
    const result = execute(s.doc, 'assign_plant_object', vesselParams(s.vessel, 2));
    expect(result.rejected).toBeUndefined();
    expect(getPlantData(result.document).objects[s.lineObject]?.properties['from']).toBe('V-102:N1');
    expect(result.affected).toContain(s.lineObject);
    expect(result.affected).toContain(s.vessel);
  });

  it('assign_plant_object without a rename does not list unrelated objects', () => {
    const s = lineAndVessel();
    const result = execute(s.doc, 'assign_plant_object', vesselParams(s.vessel, 1));
    expect(result.rejected).toBeUndefined();
    expect(getPlantData(result.document).objectOrder).toHaveLength(2);
    expect(result.affected).toEqual([getPlantData(result.document).objectOrder[1]]);
  });

  it('renumber_tags lists the line object whose from followed a retagged vessel', () => {
    const s = lineAndVessel();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.vessel, 2));
    const result = execute(tagged, 'renumber_tags', { className: 'PressureVessel', startSequence: 5 });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(getPlantData(result.document).objects[s.lineObject]?.properties['from']).toBe('V-105:N1');
    expect(result.affected).toContain(s.lineObject);
  });
});

describe('a direct rename of classified equipment is refused (DAT_DIRECT_RENAME)', () => {
  it('rename_equipment_tag refuses it, the document is unchanged, remediation names the plant-data way', () => {
    const s = lineAndVessel();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.vessel, 2));
    const refused = expectRefusal(tagged, 'rename_equipment_tag', { renames: [{ equipment: 'V-102', tag: 'V-900' }] }, 'DAT_DIRECT_RENAME');
    expect(refused.error?.ids).toContain(s.vessel);
    expect(refused.error?.remediation).toContain('unassign_plant_object');
  });

  it('update_equipment with a new mark is refused the same way; other edits of the equipment stay legal', () => {
    const equipment = addEquipment(libraryDocument());
    const classified = apply(equipment.doc, 'assign_plant_object', {
      target: equipment.id,
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'A pump', DesignPressure: 10 },
    });
    const mark = (classified.building?.elements[equipment.id] as { mark: string }).mark;
    const renamed = execute(classified, 'update_equipment', { elementId: equipment.id, mark: 'P-900' });
    expect(renamed.document).toBe(classified);
    expect(renamed.summary).toContain('DAT_DIRECT_RENAME');
    expect(mark).not.toBe('P-900');
    const moved = execute(classified, 'update_equipment', { elementId: equipment.id, weight: 123 });
    expect(moved.rejected).toBeUndefined();
    expect(moved.affected).toContain(equipment.id);
  });

  it('a rename through plant data (retag) and a rename of unclassified or unassigned equipment are legal', () => {
    const s = lineAndVessel();
    const free = execute(s.doc, 'rename_equipment_tag', { renames: [{ equipment: 'V-101', tag: 'V-900' }] });
    expect(free.rejected).toBeUndefined();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.vessel, 2));
    const retagged = execute(tagged, 'renumber_tags', { className: 'PressureVessel', startSequence: 8 });
    expect(retagged.rejected, retagged.summary).toBeUndefined();
    const objectId = getPlantData(tagged).objectOrder.find(
      (id) => getPlantData(tagged).objects[id]?.className === 'PressureVessel',
    ) as string;
    const unassigned = apply(tagged, 'unassign_plant_object', { objects: [objectId] });
    const renamed = execute(unassigned, 'rename_equipment_tag', { renames: [{ equipment: 'V-102', tag: 'V-901' }] });
    expect(renamed.rejected, renamed.summary).toBeUndefined();
  });

  it('a mark that no longer agrees with its object (a hand-edited file) can be renamed back', () => {
    const s = lineAndVessel();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.vessel, 2));
    const drifted = markEquipmentByHand(tagged, s.vessel, 'V-777');
    const back = execute(drifted, 'rename_equipment_tag', { renames: [{ equipment: 'V-777', tag: 'V-102' }] });
    expect(back.rejected, back.summary).toBeUndefined();
  });
});

/** An empty-level document with one tray, one pipe support and two steel members. */
function structureDocument(): { doc: CadDocument; tray: string; support: string; beam: string; column: string } {
  const pipe = addPipe(libraryDocument(), { line: 'L-1' });
  let doc = apply(pipe.doc, 'add_cable_tray', {
    points: [
      [0, 0, 3000],
      [4000, 0, 3000],
    ],
  });
  doc = apply(doc, 'add_steel_member', { profile: 'IPE400', role: 'beam', start: [0, 0, 3000], end: [6000, 0, 3000] });
  doc = apply(doc, 'add_steel_member', { profile: 'HEA300', role: 'column', start: [0, 0, 0], end: [0, 0, 3000] });
  doc = apply(doc, 'add_pipe_support', { pipeId: pipe.id, spacing: 4000 });
  const elements = Object.values(doc.building?.elements ?? {});
  const idOf = (category: string, index = 0): string => elements.filter((element) => element.category === category)[index]?.id as string;
  return { doc, tray: idOf('tray'), support: idOf('pipeSupport'), beam: idOf('member', 0), column: idOf('member', 1) };
}

const markOf = (doc: CadDocument, id: string): string | undefined => doc.building?.elements[id]?.mark;

describe('rename_element_tag', () => {
  it('renames a tray, a pipe support and members by id or by tag; ids, order and geometry are untouched', () => {
    const s = structureDocument();
    const result = execute(s.doc, 'rename_element_tag', {
      renames: [
        { element: s.tray, tag: 'CT-1' },
        { element: s.support, tag: 'PS-1' },
        { element: markOf(s.doc, s.beam) as string, tag: 'BM-1' },
      ],
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected).toEqual([s.tray, s.support, s.beam]);
    expect([markOf(result.document, s.tray), markOf(result.document, s.support), markOf(result.document, s.beam)]).toEqual([
      'CT-1',
      'PS-1',
      'BM-1',
    ]);
    expect(markOf(result.document, s.column)).toBe(markOf(s.doc, s.column));
    expect(result.document.building?.elementOrder).toEqual(s.doc.building?.elementOrder);
    expect((result.data as { renamed: unknown[] }).renamed).toHaveLength(3);
    const tray = result.document.building?.elements[s.tray] as BuildingElement;
    expect(tray).toEqual({ ...(s.doc.building?.elements[s.tray] as BuildingElement), mark: 'CT-1' });
  });

  it('is pure: the argument document is not changed', () => {
    const s = structureDocument();
    const before = JSON.stringify(s.doc);
    execute(s.doc, 'rename_element_tag', { renames: [{ element: s.tray, tag: 'CT-1' }] });
    expect(JSON.stringify(s.doc)).toBe(before);
  });

  it('a swap of two members is valid, a rename to the same tag changes nothing', () => {
    const s = structureDocument();
    const a = markOf(s.doc, s.beam) as string;
    const b = markOf(s.doc, s.column) as string;
    const swapped = apply(s.doc, 'rename_element_tag', {
      renames: [
        { element: s.beam, tag: b },
        { element: s.column, tag: a },
      ],
    });
    expect([markOf(swapped, s.beam), markOf(swapped, s.column)]).toEqual([b, a]);
    const same = execute(s.doc, 'rename_element_tag', { renames: [{ element: s.beam, tag: a }] });
    expect(same.document).toBe(s.doc);
    expect(same.affected).toEqual([]);
  });

  it('refuses unknown elements, other categories, bad tags, duplicates and assembly parts (document unchanged)', () => {
    const s = structureDocument();
    expectRefusal(s.doc, 'rename_element_tag', { renames: [{ element: 'tray-99', tag: 'X' }] }, 'EQP_NOT_FOUND', 'renames[0].element');
    const equipment = addEquipment(s.doc);
    expectRefusal(equipment.doc, 'rename_element_tag', { renames: [{ element: equipment.id, tag: 'X' }] }, 'EQP_NOT_FOUND');
    for (const tag of ['', 'A B', 'A:B'])
      expectRefusal(s.doc, 'rename_element_tag', { renames: [{ element: s.tray, tag }] }, 'EQP_PARAM_INVALID', 'renames[0].tag');
    const twin = apply(s.doc, 'add_cable_tray', {
      points: [
        [0, 1000, 3000],
        [4000, 1000, 3000],
      ],
    });
    const second = Object.values(twin.building?.elements ?? {}).filter((element) => element.category === 'tray')[1] as BuildingElement;
    const clash = expectRefusal(
      twin,
      'rename_element_tag',
      { renames: [{ element: second.id, tag: markOf(twin, s.tray) as string }] },
      'EQP_TAG_DUPLICATE',
    );
    expect(clash.error?.ids).toEqual([s.tray, second.id]);
    const member = s.doc.building?.elements[s.beam] as BuildingElement;
    const generated: CadDocument = {
      ...s.doc,
      building: {
        ...(s.doc.building as NonNullable<CadDocument['building']>),
        elements: { ...s.doc.building?.elements, [s.beam]: { ...member, assemblyId: 'assembly-1' } as BuildingElement },
      },
    };
    expectRefusal(generated, 'rename_element_tag', { renames: [{ element: s.beam, tag: 'Z1' }] }, 'EQP_ELEMENT_READONLY');
  });

  it('a tray, a support and a member become classifiable: the plant tag is written back as their mark, and the tag is held in the registry', () => {
    const s = structureDocument();
    let doc = s.doc;
    for (const [index, target] of [s.tray, s.support, s.beam].entries()) {
      doc = apply(doc, 'assign_plant_object', vesselParams(target, index + 4));
      expect(markOf(doc, target)).toBe(`V-10${index + 4}`);
    }
    expect(
      data<{ status: string; findings: Array<{ code: string }> }>(doc, 'check_plant_data', {}).findings.map((finding) => finding.code),
    ).not.toContain('DAT_TAG_MODEL_MISMATCH');
    const clash = expectRefusal(doc, 'assign_plant_object', { ...vesselParams('reserved', 4) }, 'DAT_TAG_DUPLICATE', 'tag');
    expect(clash.summary).toContain('V-104');
    const unclassified = data<{ findings: Array<{ code: string; ids: string[] }> }>(s.doc, 'check_plant_data', {}).findings;
    const listed = unclassified.filter((finding) => finding.code === 'DAT_UNCLASSIFIED_ELEMENT').flatMap((finding) => finding.ids);
    expect(listed).not.toContain(s.tray);
    expect(listed).not.toContain(s.support);
    expect(listed).not.toContain(s.beam);
  });

  it('a class tag format the mark grammar cannot carry is refused before anything is written', () => {
    const s = structureDocument();
    const spaced = apply(s.doc, 'define_plant_class', { name: 'SpacedVessel', parent: 'PressureVessel', tagFormat: '{classCode} {seq:3}' });
    const refused = execute(spaced, 'assign_plant_object', { ...vesselParams(s.tray, 1), className: 'SpacedVessel' });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('DAT_TAG_FORMAT');
    expect(refused.document).toBe(spaced);
  });
});

/** A document with a colour profile of `when` clauses on `mark` (09 VIS). */
function withMarkRules(doc: CadDocument, rules: Array<Record<string, unknown>>): CadDocument {
  return apply(doc, 'define_colour_profile', {
    id: 'by-tag',
    name: 'By tag',
    rules: rules.map((when, index) => ({ id: `r${index}`, when, colour: '#ff0000', legend: `rule ${index}` })),
  });
}
const whenOf = (doc: CadDocument): unknown[] => (doc.display?.colourProfiles['by-tag']?.rules ?? []).map((rule) => rule.when);

describe('display colour rules follow a rename', () => {
  it('rename_equipment_tag rewrites equals / in / any clauses on the old mark, all at once (a swap stays a swap)', () => {
    const one = addEquipment(libraryDocument(), { mark: 'P-1' });
    const two = addEquipment(one.doc, { mark: 'P-2', location: [5000, 0] });
    const doc = withMarkRules(two.doc, [
      { property: 'mark', equals: 'P-1' },
      { property: 'mark', in: ['P-2', 'P-9'] },
      {
        any: [
          { property: 'mark', equals: 'p-2' },
          { property: 'service', equals: 'cw' },
        ],
      },
      { property: 'layerName', equals: 'P-1' },
    ]);
    const result = execute(doc, 'rename_equipment_tag', {
      renames: [
        { equipment: 'P-1', tag: 'P-2' },
        { equipment: 'P-2', tag: 'P-1' },
      ],
    });
    expect(result.rejected, result.summary).toBeUndefined();
    expect(whenOf(result.document)).toEqual([
      { property: 'mark', equals: 'P-2' },
      { property: 'mark', in: ['P-1', 'P-9'] },
      {
        any: [
          { property: 'mark', equals: 'P-1' },
          { property: 'service', equals: 'cw' },
        ],
      },
      { property: 'layerName', equals: 'P-1' },
    ]);
    expect((result.data as { colourRules: string[] }).colourRules).toEqual(['by-tag/r0', 'by-tag/r1', 'by-tag/r2']);
    expect(result.summary).toContain('3 colour rule(s)');
  });

  it('a rule on a mark another element still carries keeps matching it; a pattern rule is reported, not rewritten', () => {
    const pump = addEquipment(libraryDocument(), { mark: 'CT1' });
    const tray = apply(pump.doc, 'add_cable_tray', {
      points: [
        [0, 0, 3000],
        [4000, 0, 3000],
      ],
    });
    expect(Object.values(tray.building?.elements ?? {}).some((element) => element.category === 'tray' && element.mark === 'CT1')).toBe(
      true,
    );
    const doc = withMarkRules(tray, [
      { property: 'mark', equals: 'T1' },
      { property: 'mark', matches: '^T' },
    ]);
    const result = execute(doc, 'rename_equipment_tag', { renames: [{ equipment: pump.id, tag: 'EQ-9' }] });
    expect(whenOf(result.document)).toEqual(whenOf(doc));
    expect((result.data as { patternRules: string[] }).patternRules).toEqual([]);
  });
  it('a rule that matches the old mark by pattern cannot be rewritten: it is reported', () => {
    const pump = addEquipment(libraryDocument(), { mark: 'CT1' });
    const doc = withMarkRules(pump.doc, [{ property: 'mark', matches: '^CT' }]);
    const result = execute(doc, 'rename_equipment_tag', { renames: [{ equipment: pump.id, tag: 'EQ-9' }] });
    expect(whenOf(result.document)).toEqual(whenOf(doc));
    expect((result.data as { patternRules: string[] }).patternRules).toEqual(['by-tag/r0']);
    expect(result.summary).toContain('by pattern');
  });

  it('rename_element_tag and a plant-data retag rewrite the rules too; a document without display is untouched', () => {
    const s = structureDocument();
    const withRule = withMarkRules(s.doc, [{ property: 'mark', equals: markOf(s.doc, s.tray) }]);
    const renamed = execute(withRule, 'rename_element_tag', { renames: [{ element: s.tray, tag: 'CT-1' }] });
    expect(whenOf(renamed.document)).toEqual([{ property: 'mark', equals: 'CT-1' }]);
    expect(renamed.summary).toContain('1 colour rule(s) followed');
    const classified = lineAndVessel();
    const ruled = withMarkRules(classified.doc, [{ property: 'mark', equals: 'V-101' }]);
    const tagged = apply(ruled, 'assign_plant_object', vesselParams(classified.vessel, 2));
    expect(whenOf(tagged)).toEqual([{ property: 'mark', equals: 'V-102' }]);
    expect(execute(classified.doc, 'rename_element_tag', { renames: [{ element: 'tray-9', tag: 'X' }] }).document).toBe(classified.doc);
    const plain = execute(addEquipment(libraryDocument(), { mark: 'Q-1' }).doc, 'rename_equipment_tag', {
      renames: [{ equipment: 'Q-1', tag: 'Q-2' }],
    });
    expect(plain.document.display).toBeUndefined();
  });
});

describe('the direct-rename guard covers trays, supports and members', () => {
  it('rename_element_tag on a classified tray / support / member is refused (DAT_DIRECT_RENAME), the document unchanged', () => {
    const s = structureDocument();
    let doc = s.doc;
    for (const [index, target] of [s.tray, s.support, s.beam].entries())
      doc = apply(doc, 'assign_plant_object', vesselParams(target, index + 4));
    for (const target of [s.tray, s.support, s.beam]) {
      const refused = expectRefusal(doc, 'rename_element_tag', { renames: [{ element: target, tag: 'FREE-1' }] }, 'DAT_DIRECT_RENAME');
      expect(refused.error?.ids).toContain(target);
    }
    expect(execute(doc, 'rename_element_tag', { renames: [{ element: s.column, tag: 'FREE-1' }] }).rejected).toBeUndefined();
  });

  it('a retag through plant data still renames a classified tray; unassigned, it renames freely', () => {
    const s = structureDocument();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.tray, 4));
    const retagged = execute(tagged, 'renumber_tags', { className: 'PressureVessel', startSequence: 7 });
    expect(retagged.rejected, retagged.summary).toBeUndefined();
    expect(markOf(retagged.document, s.tray)).toBe('V-107');
    const objectId = getPlantData(tagged).objectOrder[0] as string;
    const free = apply(tagged, 'unassign_plant_object', { objects: [objectId] });
    expect(execute(free, 'rename_element_tag', { renames: [{ element: s.tray, tag: 'FREE-1' }] }).rejected).toBeUndefined();
  });

  it('is cheap on a large unclassified building: no scan when the elements record is unchanged, no registry for an unclassified rename', () => {
    const s = structureDocument();
    const tagged = apply(s.doc, 'assign_plant_object', vesselParams(s.tray, 4));
    const building = tagged.building as NonNullable<CadDocument['building']>;
    const template = building.elements[s.column] as BuildingElement;
    const elements: Record<string, BuildingElement> = { ...building.elements };
    const order = [...building.elementOrder];
    for (let index = 0; index < 20000; index++) {
      elements[`member-big-${index}`] = { ...template, id: `member-big-${index}`, mark: `B${index}` } as BuildingElement;
      order.push(`member-big-${index}`);
    }
    const big: CadDocument = { ...tagged, building: { ...building, elements, elementOrder: order } };
    const started = performance.now();
    const same = execute(big, 'update_equipment', { elementId: 'none' });
    const renamed = execute(big, 'rename_element_tag', { renames: [{ element: 'member-big-5', tag: 'B-FREE' }] });
    expect(renamed.rejected, renamed.summary).toBeUndefined();
    expect(same.document).toBe(big);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
