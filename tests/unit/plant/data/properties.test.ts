/**
 * Plant 08 DAT M1: `set_plant_properties` (TR-DAT-10, VC-DAT-14): the batch is atomic and one feature step, values are typed with units and provenance, a
 * tag-driving property regenerates the tag and writes it into the model. Also the typed values and unit conversions underneath.
 */

import type { CadDocument } from '@core/model/types';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { coerceValue, definitionProblem } from '@aec/plant/data/properties';
import { convertUnit, isKnownUnit, lowestValue, unitsOf } from '@aec/plant/data/units';
import { getPlantData, type PropertyDefinition } from '@aec/plant/data/model';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addEquipment, addPipe, assignPump, libraryDocument } from './dataFixtures';

/** Two tagged pumps (P-101, P-102) and one tagged legacy pipe (50-CWS-0007-B2). */
function scene(): {
  doc: CadDocument;
  a: { doc: CadDocument; id: string };
  b: { doc: CadDocument; id: string };
  pipe: { doc: CadDocument; id: string };
  pumpA: string;
  pumpB: string;
  line: string;
} {
  let doc = libraryDocument();
  const a = addEquipment(doc, { name: 'A' });
  const pa = assignPump(a.doc, a.id);
  const b = addEquipment(pa.doc, { name: 'B' });
  const pb = assignPump(b.doc, b.id);
  const pipe = addPipe(pb.doc, { line: 'L-1', service: 'cw' });
  doc = apply(pipe.doc, 'assign_plant_object', {
    target: pipe.id,
    className: 'ProcessLine',
    hierarchy: 'U10',
    tagFields: { fluidCode: 'CWS', seq: 7, spec: 'B2' },
  });
  const objects = getPlantData(doc).objectOrder;
  return { doc, a, b, pipe, pumpA: objects[0] as string, pumpB: objects[1] as string, line: objects[2] as string };
}

describe('set_plant_properties', () => {
  it('applies a batch as ONE feature step, by id or by tag, and reports the changed values', () => {
    const s = scene();
    const steps = s.doc.featureHistory.length;
    const result = ok(s.doc, 'set_plant_properties', {
      edits: [
        { object: 'P-101', property: 'DesignPressure', value: 25 },
        { object: s.pumpB, property: 'Service', value: 'feed' },
        { object: 'P-101', property: 'DesignTemperature', value: { value: 212, unit: 'degF' } },
      ],
    });
    expect(result.data).toMatchObject({ changed: 3, objects: [s.pumpA, s.pumpB], retagged: [] });
    expect(result.affected).toEqual([s.pumpA, s.pumpB]);
    expect(result.document.featureHistory).toHaveLength(steps + 1);
    const pumpA = getPlantData(result.document).objects[s.pumpA];
    expect(pumpA?.properties['DesignPressure']).toBe(25);
    expect(pumpA?.properties['DesignTemperature']).toBeCloseTo(100, 9);
    expect(getPlantData(result.document).objects[s.pumpB]?.properties['Service']).toBe('feed');
  });

  it('converts a unit of the same family and refuses gauge against absolute pressure', () => {
    const s = scene();
    const kpa = ok(s.doc, 'set_plant_properties', {
      edits: [{ object: 'P-101', property: 'DesignPressure', value: { value: 2500, unit: 'kPag' } }],
    });
    expect(getPlantData(kpa.document).objects[s.pumpA]?.properties['DesignPressure']).toBeCloseTo(25, 12);
    const refusal = expectRefusal(
      s.doc,
      'set_plant_properties',
      { edits: [{ object: 'P-101', property: 'DesignPressure', value: { value: 5, unit: 'bara' } }] },
      'DAT_PROPERTY_UNIT',
      'edits[0].value',
    );
    expect(refusal.summary).toContain('gauge and absolute');
  });

  it('null clears a value; an unchanged request changes nothing and is not a refusal', () => {
    const s = scene();
    const cleared = ok(s.doc, 'set_plant_properties', { edits: [{ object: 'P-101', property: 'DesignPressure', value: null }] });
    expect(getPlantData(cleared.document).objects[s.pumpA]?.properties['DesignPressure']).toBeUndefined();
    const same = execute(s.doc, 'set_plant_properties', { edits: [{ object: 'P-101', property: 'DesignPressure', value: 10 }] });
    expect(same.document).toBe(s.doc);
    expect(same.rejected).toBeUndefined();
    expect(same.summary).toContain('nothing changed');
  });

  it('records provenance, flags unverified values, and an edit without provenance drops the old one', () => {
    const s = scene();
    const flagged = apply(s.doc, 'set_plant_properties', {
      edits: [
        {
          object: 'P-101',
          property: 'DesignPressure',
          value: 18,
          provenance: { source: 'datasheet', ref: 'DS-101 rev B', unverified: true },
        },
      ],
    });
    expect(getPlantData(flagged).objects[s.pumpA]?.provenance).toEqual({
      DesignPressure: { source: 'datasheet', ref: 'DS-101 rev B', unverified: true },
    });
    const table = data<{ rows: Array<{ unverified: string }> }>(flagged, 'plant_data_table', {
      className: 'CentrifugalPump',
      columns: ['unverified'],
    });
    expect(table.rows.map((row) => row.unverified)).toEqual(['DesignPressure', '']);
    const cleared = apply(flagged, 'set_plant_properties', { edits: [{ object: 'P-101', property: 'DesignPressure', value: 19 }] });
    expect(getPlantData(cleared).objects[s.pumpA]?.provenance).toBeUndefined();
  });

  it('is atomic: one invalid edit refuses the whole batch and lists every bad edit in paths', () => {
    const s = scene();
    const refusal = expectRefusal(
      s.doc,
      'set_plant_properties',
      {
        edits: [
          { object: 'P-101', property: 'DesignPressure', value: 30 },
          { object: 'P-101', property: 'DesignPressure', value: 'very high' },
          { object: 'NOPE-1', property: 'Description', value: 'x' },
          { object: 'P-101', property: 'Colour', value: 'red' },
          { object: 'P-101', property: 'tag', value: 'X-1' },
        ],
      },
      'DAT_PROPERTY_TYPE',
    );
    expect(refusal.error?.paths).toEqual(['edits[1].value', 'edits[2].object', 'edits[3].property', 'edits[4].property']);
    expect((refusal.error?.detail as { errorCount: number }).errorCount).toBe(4);
    expect(getPlantData(s.doc).objects[s.pumpA]?.properties['DesignPressure']).toBe(10);
  });

  it.each([
    ['DAT_OBJECT_UNKNOWN', { object: 'NOPE-1', property: 'Description', value: 'x' }],
    ['DAT_PROPERTY_UNKNOWN', { object: 'P-101', property: 'Colour', value: 'red' }],
    ['DAT_PROPERTY_READONLY', { object: 'P-101', property: 'className', value: 'Tank' }],
    ['DAT_PROPERTY_TYPE', { object: '50-CWS-0007-B2', property: 'nominalSize', value: 2.5 }],
    ['DAT_PROPERTY_TYPE', { object: '50-CWS-0007-B2', property: 'fluidCode', value: 'lower' }],
    ['DAT_PROPERTY_TYPE', { object: 'P-101', property: 'DesignTemperature', value: -300 }],
  ])('refuses %s', (code, edit) => {
    expectRefusal(
      scene().doc,
      'set_plant_properties',
      { edits: [edit] },
      code,
      'edits[0].' + (code === 'DAT_OBJECT_UNKNOWN' ? 'object' : code === 'DAT_PROPERTY_TYPE' && 'value' in edit ? 'value' : 'property'),
    );
  });

  it('refuses a tag that exists in two plants by id only, and a read-only property', () => {
    const s = scene();
    const ro = apply(s.doc, 'define_plant_class', {
      name: 'Locked',
      parent: 'CentrifugalPump',
      properties: [{ name: 'Serial', type: 'text', readOnly: true }],
    });
    const added = addEquipment(ro, { name: 'C' });
    const locked = apply(added.doc, 'assign_plant_object', {
      target: added.id,
      className: 'Locked',
      hierarchy: 'U10',
      nextSequence: true,
      properties: { Description: 'c', DesignPressure: 1 },
    });
    expectRefusal(
      locked,
      'set_plant_properties',
      { edits: [{ object: 'P-103', property: 'Serial', value: 'x' }] },
      'DAT_PROPERTY_READONLY',
      'edits[0].property',
    );
    const twin = apply(locked, 'define_plant_hierarchy', {
      nodes: [{ code: 'U20', kind: 'unit', parent: 'P2', properties: { areaNumber: '1' } }],
    });
    const reserved = apply(twin, 'assign_plant_object', {
      target: 'reserved',
      className: 'CentrifugalPump',
      hierarchy: 'U20',
      tagFields: { seq: 1 },
      properties: { Description: 'r', DesignPressure: 1 },
    });
    expectRefusal(
      reserved,
      'set_plant_properties',
      { edits: [{ object: 'P-101', property: 'Service', value: 'x' }] },
      'DAT_OBJECT_UNKNOWN',
      'edits[0].object',
    );
  });

  it('a tag-driving property regenerates the tag and writes it into the model; a duplicate refuses the batch', () => {
    const s = scene();
    const renamed = ok(s.doc, 'set_plant_properties', {
      edits: [
        { object: '50-CWS-0007-B2', property: 'nominalSize', value: 80 },
        { object: '50-CWS-0007-B2', property: 'spec', value: 'C1' },
      ],
    });
    expect((renamed.data as { retagged: unknown[] }).retagged).toEqual([{ id: s.line, from: '50-CWS-0007-B2', to: '80-CWS-0007-C1' }]);
    const pipe = renamed.document.building?.elements[s.pipe.id];
    expect(pipe?.category === 'pipe' && pipe.line).toBe('80-CWS-0007-C1');
    expect(data<{ status: string }>(renamed.document, 'check_plant_data', {}).status).toMatch(/pass|warn/);
    const other = addPipe(s.doc, { line: 'L-2', dn: 80 });
    const second = apply(other.doc, 'assign_plant_object', {
      target: other.id,
      className: 'ProcessLine',
      hierarchy: 'U10',
      tagFields: { fluidCode: 'CWS', seq: 7, spec: 'B2' },
    });
    expect(Object.values(getPlantData(second).objects).at(-1)?.tag).toBe('80-CWS-0007-B2');
    const clash = expectRefusal(
      second,
      'set_plant_properties',
      { edits: [{ object: '80-CWS-0007-B2', property: 'nominalSize', value: 50 }] },
      'DAT_TAG_DUPLICATE',
    );
    expect(clash.error?.ids).toEqual(expect.arrayContaining([s.line]));
  });

  it('is pure, deterministic and replays to the same plant data', () => {
    const s = scene();
    const before = structuredClone(s.doc);
    const params = { edits: [{ object: 'P-101', property: 'DesignPressure', value: 31 }] };
    const first = execute(s.doc, 'set_plant_properties', params);
    expect(s.doc).toEqual(before);
    expect(execute(s.doc, 'set_plant_properties', params).document).toEqual(first.document);
    const replayed = execute(first.document, 'replay_history', {}).document;
    expect(replayed.plant?.data).toEqual(first.document.plant?.data);
    expect(replayed.building?.elements[s.a.id]?.mark).toBe('P-101');
  });
});

describe('typed values and units', () => {
  const definition = (extra: Partial<PropertyDefinition>): PropertyDefinition => ({ name: 'V', displayName: 'V', type: 'text', ...extra });

  it('converts every unit family and rounds back', () => {
    expect(convertUnit('pressure', 16, 'barg', 'kPag')).toBeCloseTo(1600, 9);
    expect(convertUnit('pressure', 1, 'MPaa', 'bara')).toBeCloseTo(10, 12);
    expect(convertUnit('pressure', 145.03773773, 'psig', 'barg')).toBeCloseTo(10, 6);
    expect(convertUnit('temperature', 0, 'degC', 'K')).toBeCloseTo(273.15, 12);
    expect(convertUnit('temperature', 212, 'degF', 'degC')).toBeCloseTo(100, 12);
    expect(convertUnit('mass', 2.5, 't', 'kg')).toBe(2500);
    expect(convertUnit('length', 1, 'in', 'mm')).toBe(25.4);
    expect(convertUnit('volumetricFlow', 1, 'l/s', 'm3/h')).toBeCloseTo(3.6, 12);
    expect(convertUnit('massFlow', 1, 'kg/s', 'kg/h')).toBe(3600);
    expect(convertUnit('pressure', 1, 'barg', 'bara')).toBeNull();
    expect(convertUnit('pressure', 1, 'furlong', 'barg')).toBeNull();
    expect(convertUnit('mass', 5, 'kg', 'kg')).toBe(5);
    expect(unitsOf('text')).toEqual([]);
    expect(isKnownUnit('mass', 'kg')).toBe(true);
    expect(lowestValue('temperature', 'degC')).toBeCloseTo(-273.15, 9);
    expect(lowestValue('pressure', 'barg')).toBeNull();
    expect(lowestValue('pressure', 'bara')).toBe(0);
    expect(lowestValue('text', 'x')).toBeNull();
  });

  it('coerces each type and explains a failure', () => {
    expect(coerceValue(definition({ type: 'boolean' }), true)).toEqual({ ok: true, value: true });
    expect(coerceValue(definition({ type: 'boolean' }), 'yes')).toMatchObject({ ok: false, code: 'DAT_PROPERTY_TYPE' });
    expect(coerceValue(definition({ type: 'enum', enumValues: ['a'] }), 'b')).toMatchObject({ ok: false });
    expect(coerceValue(definition({ type: 'integer' }), 3)).toEqual({ ok: true, value: 3 });
    expect(coerceValue(definition({ type: 'real' }), 3.5)).toEqual({ ok: true, value: 3.5 });
    expect(coerceValue(definition({ type: 'text' }), 3)).toMatchObject({ ok: false });
    expect(coerceValue(definition({ type: 'text' }), null)).toEqual({ ok: true, value: null });
    expect(coerceValue(definition({ type: 'real' }), { value: 1, unit: 'mm' })).toMatchObject({ ok: false, code: 'DAT_PROPERTY_TYPE' });
    expect(coerceValue(definition({ type: 'length', unit: 'mm' }), { value: 'x' as unknown as number, unit: 'mm' })).toMatchObject({
      ok: false,
    });
    expect(coerceValue(definition({ type: 'mass', unit: 'kg' }), -1)).toMatchObject({ ok: false });
    expect(coerceValue(definition({ type: 'length', unit: 'mm' }), Number.NaN)).toMatchObject({ ok: false });
    expect(coerceValue(definition({ type: 'length', unit: 'mm' }), { value: 1, unit: 'm' })).toEqual({ ok: true, value: 1000 });
  });

  it('rejects invalid definitions', () => {
    expect(definitionProblem(definition({ name: '1x' }))).toContain('identifier');
    expect(definitionProblem(definition({ type: 'nope' as PropertyDefinition['type'] }))).toContain('unknown type');
    expect(definitionProblem(definition({ type: 'text', enumValues: ['a'] }))).toContain('enumValues');
    expect(definitionProblem(definition({ type: 'text', pattern: '[A-Z]+', default: 'ABC' }))).toBeNull();
    expect(definitionProblem(definition({ type: 'text', pattern: '[A-Z]+', default: 'abc' }))).toContain('default');
    expect(definitionProblem(definition({ type: 'integer', pattern: '1' }))).toContain('pattern');
  });
});
