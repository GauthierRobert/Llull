/**
 * Plant 08 DAT M1: `check_plant_data` MVP rules (TR-DAT-30, VC-DAT-12), one test per rule with codes, ids and paths; the existing tag fields of the model
 * (equipment marks, tie-in battery limits, nozzles `<tag>:<mark>`, inline component tags, routed line numbers) feed the line-end resolution and the registry.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { copyObject, getPlantData } from '@aec/plant/data/model';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { addTie, routedPumpToVessel, valveScene } from '../piping/rteFixtures';
import { addEquipment, addPipe, assignPump, libraryDocument, withData } from './dataFixtures';

interface Finding {
  code: string;
  severity: string;
  ids: string[];
  paths: string[];
  message: string;
  remediation: string;
}
interface Check {
  status: string;
  findings: Finding[];
  counts: { fail: number; warn: number; info: number };
  checked: number;
  defaults: { batteryLimitPattern: string };
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): Check => data<Check>(doc, 'check_plant_data', params);
const codes = (result: Check): string[] => result.findings.map((finding) => finding.code);

const lineParams = (target: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  target,
  className: 'ProcessLine',
  hierarchy: 'U10',
  tagFields: { nominalSize: 50, fluidCode: 'CWS', seq: 7, spec: 'B2' },
  ...extra,
});

/** One tagged pump P-101 and one tagged line 50-CWS-0007-B2 from P-101 to `to`. */
function pumpAndLine(
  to: string,
  lineExtra: Record<string, unknown> = {},
): {
  doc: CadDocument;
  pump: { doc: CadDocument; id: string };
  pipe: { doc: CadDocument; id: string };
  pumpObject: string;
  lineObject: string;
} {
  const pump = addEquipment(libraryDocument());
  const tagged = assignPump(pump.doc, pump.id);
  const pipe = addPipe(tagged.doc, { line: 'L-1', from: 'P-101', to, service: 'cw' });
  const doc = apply(pipe.doc, 'assign_plant_object', lineParams(pipe.id, lineExtra));
  return { doc, pump, pipe, pumpObject: tagged.objectId, lineObject: getPlantData(doc).objectOrder.at(-1) as string };
}

describe('check_plant_data', () => {
  it('passes an empty document and a clean one, with the battery-limit default named (AF-31)', () => {
    const empty = check(apply(libraryDocument(), 'set_units', { units: 'mm' }));
    expect(empty).toMatchObject({ status: 'pass', findings: [], counts: { fail: 0, warn: 0, info: 0 }, checked: 0 });
    expect(empty.defaults.batteryLimitPattern).toBe('^(BL|TI)-');
    const clean = check(pumpAndLine('BL-1').doc);
    expect(clean.status).toBe('pass');
    expect(clean.findings).toEqual([]);
  });

  it('DAT_LINE_END_UNRESOLVED: a to that is no tag and no battery limit fails with the line path; a tag or a battery limit resolves (VC-DAT-12)', () => {
    const found = check(pumpAndLine('E-999').doc);
    expect(found.status).toBe('fail');
    expect(found.findings).toHaveLength(1);
    expect(found.findings[0]).toMatchObject({ code: 'DAT_LINE_END_UNRESOLVED', severity: 'fail', paths: ['50-CWS-0007-B2.to'] });
    expect(found.findings[0]?.remediation).toContain('BL-');
    expect(check(pumpAndLine('BL-7').doc).findings).toEqual([]);
    expect(check(pumpAndLine('TI-3').doc).findings).toEqual([]);
  });

  it('a line end resolves to a tie-in battery limit, the property of the object wins over the pipe, and a missing end warns', () => {
    const scene = pumpAndLine('TP-9');
    expect(codes(check(scene.doc))).toEqual(['DAT_LINE_END_UNRESOLVED']);
    const withTie = addTie(scene.doc, 'TP-9', [0, 0, 0], [1, 0, 0], { kind: 'battery_limit' }).doc;
    expect(check(withTie).findings).toEqual([]);
    const overridden = apply(withTie, 'set_plant_properties', { edits: [{ object: scene.lineObject, property: 'to', value: 'NOWHERE' }] });
    expect(check(overridden).findings[0]).toMatchObject({ code: 'DAT_LINE_END_UNRESOLVED', paths: ['50-CWS-0007-B2.to'] });
    const open = pumpAndLine('');
    expect(check(open.doc).findings).toEqual([
      expect.objectContaining({ code: 'DAT_LINE_END_UNRESOLVED', severity: 'warn', paths: ['50-CWS-0007-B2.to'] }),
    ]);
  });

  it('the equipment mark of a not yet classified equipment is a tag of the model: the end resolves, the equipment is reported unclassified', () => {
    const scene = pumpAndLine('V-300');
    const other = addEquipment(scene.doc, { name: 'Vessel', mark: 'V-300' });
    const result = check(other.doc);
    expect(codes(result)).toEqual(['DAT_UNCLASSIFIED_ELEMENT']);
    expect(result.findings[0]).toMatchObject({ severity: 'warn', ids: [other.id] });
    expect(result.status).toBe('warn');
  });

  it('DAT_REQUIRED_PROPERTY_MISSING: names the object and the property (VC-DAT-12)', () => {
    const pump = addEquipment(libraryDocument());
    const doc = apply(pump.doc, 'assign_plant_object', {
      target: pump.id,
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      nextSequence: true,
    });
    const result = check(doc);
    expect(result.status).toBe('fail');
    expect(result.findings.map((finding) => finding.paths[0])).toEqual(['P-101.DesignPressure']);
    expect(result.findings[0]).toMatchObject({ code: 'DAT_REQUIRED_PROPERTY_MISSING', ids: [getPlantData(doc).objectOrder[0], pump.id] });
    const cleared = apply(assignPump(addEquipment(libraryDocument()).doc, 'equipment-1').doc, 'set_plant_properties', {
      edits: [{ object: 'P-101', property: 'Description', value: null }],
    });
    expect(codes(check(cleared))).toEqual(['DAT_REQUIRED_PROPERTY_MISSING']);
  });

  it('DAT_TAG_FORMAT: a hand-edited tag, an unreadable field and a changed format are failures', () => {
    const scene = pumpAndLine('BL-1');
    const edited = withData(scene.doc, (current) => ({
      ...current,
      objects: { ...current.objects, [scene.pumpObject]: copyObject(current.objects[scene.pumpObject] as never, { tag: 'P-199' }) },
    }));
    const result = check(edited);
    expect(result.findings[0]).toMatchObject({
      code: 'DAT_TAG_FORMAT',
      severity: 'fail',
      ids: [scene.pumpObject, scene.pump.id],
      paths: ['P-199.tag'],
    });
    expect(result.findings[0]?.message).toContain('P-101');
    expect(result.findings.map((finding) => finding.code)).toContain('DAT_TAG_MODEL_MISMATCH');
    const missing = withData(scene.doc, (current) => ({
      ...current,
      objects: {
        ...current.objects,
        [scene.pumpObject]: { ...(current.objects[scene.pumpObject] as never as Record<string, unknown>), tagFields: {} } as never,
      },
    }));
    expect(check(missing).findings[0]?.message).toContain('{seq}');
  });

  it('DAT_TAG_DUPLICATE and DAT_TAG_CASE_COLLISION in a hand-edited file', () => {
    const scene = pumpAndLine('BL-1');
    const second = addEquipment(scene.doc, { name: 'B' });
    const tagged = assignPump(second.doc, second.id);
    const duplicated = withData(tagged.doc, (current) => ({
      ...current,
      objects: { ...current.objects, [tagged.objectId]: copyObject(current.objects[tagged.objectId] as never, { tag: 'P-101' }) },
    }));
    expect(check(duplicated).findings.filter((finding) => finding.code === 'DAT_TAG_DUPLICATE')).toEqual([
      expect.objectContaining({ severity: 'fail', ids: [scene.pumpObject, tagged.objectId], paths: ['P-101'] }),
    ]);
    const cased = withData(tagged.doc, (current) => ({
      ...current,
      objects: { ...current.objects, [tagged.objectId]: copyObject(current.objects[tagged.objectId] as never, { tag: 'p-101' }) },
    }));
    expect(check(cased).findings.find((finding) => finding.code === 'DAT_TAG_CASE_COLLISION')).toMatchObject({
      severity: 'warn',
      ids: [scene.pumpObject, tagged.objectId],
    });
  });

  it('DAT_LINE_SIZE_MISMATCH: the line nominalSize differs from the DN of the pipe', () => {
    const scene = pumpAndLine('BL-1');
    const resized = withData(scene.doc, (current) => ({
      ...current,
      objects: {
        ...current.objects,
        [scene.lineObject]: copyObject(current.objects[scene.lineObject] as never, {
          properties: { ...current.objects[scene.lineObject]?.properties, nominalSize: 80 },
        }),
      },
    }));
    const found = check(resized).findings.find((finding) => finding.code === 'DAT_LINE_SIZE_MISMATCH');
    expect(found).toMatchObject({ severity: 'warn', ids: [scene.lineObject, scene.pipe.id], paths: ['50-CWS-0007-B2.nominalSize'] });
  });

  it('DAT_OBJECT_ORPHAN: the model element was deleted; DAT_TAG_MODEL_MISMATCH: it was renamed', () => {
    const scene = pumpAndLine('BL-1');
    const renamed = apply(scene.doc, 'update_equipment', { elementId: scene.pump.id, mark: 'ZZ-1' });
    expect(check(renamed).findings).toEqual([
      expect.objectContaining({ code: 'DAT_TAG_MODEL_MISMATCH', severity: 'warn', ids: [scene.pumpObject, scene.pump.id] }),
    ]);
    const deleted = apply(scene.doc, 'delete_building_element', { elementIds: [scene.pump.id] });
    const result = check(deleted);
    expect(result.findings.find((finding) => finding.code === 'DAT_OBJECT_ORPHAN')).toMatchObject({
      severity: 'warn',
      ids: [scene.pumpObject],
      paths: ['P-101.target'],
    });
    expect(result.findings.find((finding) => finding.code === 'DAT_LINE_END_UNRESOLVED')).toBeUndefined();
  });

  it('DAT_OUTSIDE_HIERARCHY, DAT_VALUE_UNVERIFIED and DAT_RESERVED_TAG_UNMODELLED', () => {
    const scene = pumpAndLine('BL-1');
    const outside = withData(scene.doc, (current) => ({
      ...current,
      objects: {
        ...current.objects,
        [scene.pumpObject]: {
          ...(current.objects[scene.pumpObject] as never as Record<string, unknown>),
          hierarchyId: 'hier-gone',
        } as never,
      },
    }));
    expect(check(outside).findings[0]).toMatchObject({
      code: 'DAT_OUTSIDE_HIERARCHY',
      severity: 'fail',
      ids: [scene.pumpObject, scene.pump.id],
    });
    const unverified = apply(scene.doc, 'set_plant_properties', {
      edits: [{ object: 'P-101', property: 'DesignPressure', value: 12, provenance: { source: 'datasheet', unverified: true } }],
    });
    expect(check(unverified).findings).toEqual([
      expect.objectContaining({ code: 'DAT_VALUE_UNVERIFIED', severity: 'warn', paths: ['P-101.DesignPressure'] }),
    ]);
    const reserved = apply(scene.doc, 'assign_plant_object', {
      target: 'reserved',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'later', DesignPressure: 3 },
    });
    const info = check(reserved);
    expect(info.findings).toEqual([
      expect.objectContaining({ code: 'DAT_RESERVED_TAG_UNMODELLED', severity: 'info', paths: ['P-102.target'] }),
    ]);
    expect(info.status).toBe('pass');
    expect(info.counts).toEqual({ fail: 0, warn: 0, info: 1 });
  });

  it('hierarchy, classes and severity restrict what is reported; status stays computed from all findings', () => {
    const scene = pumpAndLine('E-999');
    const other = apply(scene.doc, 'define_plant_hierarchy', {
      nodes: [{ code: 'U30', kind: 'unit', parent: 'P2', properties: { areaNumber: '3' } }],
    });
    const tank = apply(other, 'assign_plant_object', { target: 'reserved', className: 'Tank', hierarchy: 'U30', nextSequence: true });
    expect(codes(check(tank, { hierarchy: 'U10' }))).toEqual(['DAT_LINE_END_UNRESOLVED']);
    expect(check(tank, { hierarchy: 'U30' }).findings.map((finding) => finding.code)).toEqual([
      'DAT_REQUIRED_PROPERTY_MISSING',
      'DAT_REQUIRED_PROPERTY_MISSING',
      'DAT_RESERVED_TAG_UNMODELLED',
    ]);
    expect(check(tank, { classes: ['ProcessLine'] }).checked).toBe(1);
    expect(check(tank, { classes: ['Equipment'], hierarchy: 'U10' }).checked).toBe(1);
    const failOnly = check(tank, { severity: 'fail' });
    expect(failOnly.findings.every((finding) => finding.severity === 'fail')).toBe(true);
    expect(failOnly.status).toBe('fail');
    expectRefusal(tank, 'check_plant_data', { hierarchy: 'U99' }, 'DAT_HIERARCHY_UNKNOWN', 'hierarchy');
    expectRefusal(tank, 'check_plant_data', { classes: ['Nope'] }, 'DAT_CLASS_UNKNOWN', 'classes');
  });

  it('is pure and its findings come in a fixed order', () => {
    const scene = pumpAndLine('E-999');
    const before = structuredClone(scene.doc);
    const first = execute(scene.doc, 'check_plant_data', {});
    expect(scene.doc).toEqual(before);
    expect(first.document).toBe(scene.doc);
    expect(execute(scene.doc, 'check_plant_data', {}).data).toEqual(first.data);
  });
});

describe('the existing piping tags feed the registry (one tag system)', () => {
  /** SC-RTE-01 (pump P-101, vessel V-101, routed line 100-P-1001-CS150 between their nozzles) with the plant data library. */
  function plantScene(): ReturnType<typeof routedPumpToVessel> {
    const base = routedPumpToVessel();
    let doc = apply(base.doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
      ],
    });
    doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
    return { ...base, doc };
  }

  it('classifies the equipment under the marks they already carry, and the nozzle ends of the routed line resolve', () => {
    const s = plantScene();
    let doc = apply(s.doc, 'assign_plant_object', {
      target: 'equipment-1',
      className: 'CentrifugalPump',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
      properties: { DesignPressure: 10 },
    });
    const vessel = Object.keys(doc.building?.elements ?? {}).find((id) => id !== 'equipment-1' && id.startsWith('equipment')) as string;
    doc = apply(doc, 'assign_plant_object', {
      target: vessel,
      className: 'PressureVessel',
      hierarchy: 'U10',
      tagFields: { seq: 1 },
      properties: { DesignPressure: 10 },
    });
    const assigned = execute(doc, 'assign_plant_object', {
      target: s.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150', DesignPressure: 10 },
    });
    expect(assigned.rejected, assigned.summary).toBeUndefined();
    expect(assigned.data).toMatchObject({
      tag: '100-P-1001-CS150',
      tagWritten: false,
      seeded: ['nominalSize', 'seq', 'DesignTemperature'],
    });
    const result = check(assigned.document);
    expect(result.findings.filter((finding) => finding.code === 'DAT_LINE_END_UNRESOLVED')).toEqual([]);
    expect(result.status).toBe('pass');
    const unknownNozzle = apply(assigned.document, 'update_pipeline', { lineId: s.line, to: 'V-101:N9' });
    expect(check(unknownNozzle).findings).toEqual([
      expect.objectContaining({ code: 'DAT_LINE_END_UNRESOLVED', paths: ['100-P-1001-CS150.to'] }),
    ]);
  });

  it('a routed line number is a tag of the registry: a typed tag equal to it is refused, and the template tag is adopted and rewritten', () => {
    const s = plantScene();
    const clash = expectRefusal(
      s.doc,
      'assign_plant_object',
      { target: 'reserved', className: 'ProcessLine', hierarchy: 'U10', tag: '100-P-1001-CS150' },
      'DAT_TAG_DUPLICATE',
      'tag',
    );
    expect(clash.error?.ids).toEqual([s.line]);
    const renumbered = apply(s.doc, 'assign_plant_object', {
      target: s.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
      tagFields: { seq: 2002 },
    });
    expect(renumbered.plant?.piping?.lines[s.line]?.lineNumber).toBe('100-P-2002-CS150');
  });

  it('an inline valve is a read-only provider: the tag it carries is adopted, a different one is refused', () => {
    const scene = valveScene();
    let doc = apply(scene.doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1' },
      ],
    });
    doc = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
    const adopted = apply(doc, 'assign_plant_object', { target: scene.valveId, className: 'IsolationValve', hierarchy: 'U10' });
    expect(Object.values(getPlantData(adopted).objects)[0]).toMatchObject({
      tag: 'XV-1001',
      properties: { valveCode: 'XV' },
      tagFields: { seq: 1001 },
      target: { kind: 'provider', provider: 'inlineComponent' },
    });
    expectRefusal(
      doc,
      'assign_plant_object',
      { target: scene.valveId, className: 'IsolationValve', hierarchy: 'U10', tag: 'XV-1002' },
      'DAT_TARGET_TAG_READONLY',
      'tag',
    );
    const clash = expectRefusal(
      doc,
      'assign_plant_object',
      { target: 'reserved', className: 'IsolationValve', hierarchy: 'U10', tag: 'XV-1001' },
      'DAT_TAG_DUPLICATE',
    );
    expect(clash.error?.ids).toEqual([scene.valveId]);
  });
});
