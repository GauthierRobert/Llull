/**
 * Plant 08 DAT M1: the tag-format grammar, generation, anchored matching and uniqueness (TR-DAT-06, 07). VC-DAT-01 / 02 read
 * `validation/data/tag_format_cases.json`: 9 generation cases, 13 validation cases, 3 uniqueness cases.
 */

import type { CadDocument } from '@core/model/types';
import { describe, expect, it } from 'vitest';
import { resolvedOrNull } from '@aec/plant/data/classes';
import { getPlantData, type PlantValue } from '@aec/plant/data/model';
import { naturalCompare } from '@aec/plant/data/naturalSort';
import { envOf, formatParts, generateFor, matchTag, nextSequence } from '@aec/plant/data/objectTag';
import { generateTag, parseTagFormat } from '@aec/plant/data/tagFormat';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { hierarchyDocument, packJson, withData } from './dataFixtures';

interface Cases {
  generate: Array<{ class: string; fields: Record<string, PlantValue>; expectedTag: string }>;
  validate: Array<{ class: string; tag: string; valid: boolean; code: string | null }>;
  uniqueness: {
    cases: Array<{ objects: Array<[string, string, string]>; expected: { code: string | null; count: number; ids?: number } }>;
  };
}

const cases = packJson<Cases>('data/tag_format_cases.json');

/** The classes of the pack: equipment (codes C E P T V), line and valve, with the property constraints of the JSON. */
function packDocument(): CadDocument {
  let doc = apply(hierarchyDocument(), 'define_plant_class', {
    name: 'EquipmentItem',
    abstract: true,
    tagFormat: '{classCode}-{area}{seq:2}',
  });
  for (const code of ['C', 'E', 'P', 'T', 'V'])
    doc = apply(doc, 'define_plant_class', { name: `Equip${code}`, parent: 'EquipmentItem', classCode: code });
  doc = apply(doc, 'define_plant_class', {
    name: 'Line',
    tagFormat: '{nominalSize}-{fluidCode}-{seq:4}-{spec}',
    properties: [
      { name: 'nominalSize', type: 'integer', required: true },
      { name: 'fluidCode', type: 'text', pattern: '[A-Z]{1,3}' },
      { name: 'spec', type: 'text', pattern: '[A-Z0-9]{2,6}' },
    ],
  });
  return apply(doc, 'define_plant_class', {
    name: 'Valve',
    tagFormat: '{valveCode}-{seq:4}',
    properties: [{ name: 'valveCode', type: 'text', pattern: '[A-Z]{1,4}' }],
  });
}

const CLASS_OF: Record<string, (fields: Record<string, PlantValue>) => string> = {
  equipment: (fields) => `Equip${String(fields['classCode'])}`,
  line: () => 'Line',
  valve: () => 'Valve',
};

describe('VC-DAT-01: tags generated from class format + fields', () => {
  const doc = packDocument();
  const model = getPlantData(doc);
  const unit = Object.values(model.hierarchy).find((node) => node.code === 'U10')?.id as string;

  it.each(cases.generate.map((entry) => [entry.expectedTag, entry] as const))('%s', (_tag, entry) => {
    const className = CLASS_OF[entry.class]?.(entry.fields) as string;
    const resolved = resolvedOrNull(model, className);
    expect(resolved).not.toBeNull();
    const rest = Object.fromEntries(Object.entries(entry.fields).filter(([name]) => name !== 'classCode' && name !== 'area'));
    const env = envOf(model, resolved as NonNullable<typeof resolved>, { hierarchyId: unit, tagFields: rest, properties: {} });
    const generated = generateFor(
      { ...env, values: { ...env.values, ...(entry.class === 'equipment' ? { area: entry.fields['area'] as PlantValue } : {}) } },
      formatParts(resolved as NonNullable<typeof resolved>) ?? [],
    );
    expect(generated).toEqual({ ok: true, tag: entry.expectedTag });
  });
});

describe('VC-DAT-02: tag validation against the class format', () => {
  const doc = packDocument();
  const model = getPlantData(doc);
  const unit = Object.values(model.hierarchy).find((node) => node.code === 'U10')?.id as string;
  const classOf = (entry: Cases['validate'][number]): string =>
    entry.class === 'equipment' ? 'EquipmentItem' : entry.class === 'line' ? 'Line' : 'Valve';

  it.each(cases.validate.map((entry) => [`${entry.class} ${entry.tag}`, entry] as const))('%s', (_label, entry) => {
    const resolved = resolvedOrNull(model, classOf(entry)) as NonNullable<ReturnType<typeof resolvedOrNull>>;
    const matched = matchTag(envOf(model, resolved, { hierarchyId: unit, tagFields: {}, properties: {} }), entry.tag);
    expect(matched.ok, entry.tag).toBe(entry.valid);
  });

  it('assign_plant_object refuses each invalid equipment tag with DAT_TAG_FORMAT and accepts the valid ones', () => {
    for (const entry of cases.validate.filter((candidate) => candidate.class === 'equipment')) {
      const params = { target: 'reserved', className: 'EquipP', hierarchy: 'U10', tag: entry.tag };
      if (entry.valid) expect(data(doc, 'assign_plant_object', params)).toMatchObject({ tag: entry.tag });
      else expectRefusal(doc, 'assign_plant_object', params, entry.code as string, 'tag');
    }
  });

  it('a typed line tag fills the tag fields and the class properties from the tag', () => {
    const next = apply(doc, 'assign_plant_object', { target: 'reserved', className: 'Line', hierarchy: 'U10', tag: '150-P-1001-A1A' });
    const object = Object.values(getPlantData(next).objects)[0];
    expect(object?.properties).toEqual({ nominalSize: 150, fluidCode: 'P', spec: 'A1A' });
    expect(object?.tagFields).toEqual({ seq: 1001 });
  });
});

describe('VC-DAT-02: uniqueness per plant (three cases)', () => {
  const doc = packDocument();
  const plantOf = (code: string): string => Object.values(getPlantData(doc).hierarchy).find((node) => node.code === code)?.id as string;
  const classOf: Record<string, string> = { equipment: 'EquipP', valve: 'Valve' };

  it.each(cases.uniqueness.cases.map((entry, index) => [`case ${index + 1}: ${entry.expected.code ?? 'allowed'}`, entry] as const))(
    '%s',
    (_label, entry) => {
      // Planted directly: assign_plant_object would refuse the duplicate, a hand-edited file carries it.
      let planted = doc;
      entry.objects.forEach(([cls, tag, plant], index) => {
        planted = withData(planted, (current) => ({
          ...current,
          objects: {
            ...current.objects,
            [`plantobj-x.${index}`]: {
              id: `plantobj-x.${index}`,
              className: classOf[cls] as string,
              hierarchyId: plantOf(plant),
              target: { kind: 'reserved' },
              tagFields: {},
              tag,
              properties: cls === 'valve' ? { valveCode: tag.split('-')[0] as string } : {},
            },
          },
          objectOrder: [...current.objectOrder, `plantobj-x.${index}`],
        }));
      });
      const found = data<{ findings: Array<{ code: string; ids: string[] }> }>(planted, 'check_plant_data', {}).findings.filter(
        (finding) => finding.code === 'DAT_TAG_DUPLICATE',
      );
      expect(found).toHaveLength(entry.expected.count);
      if (entry.expected.ids !== undefined) expect(found[0]?.ids).toHaveLength(entry.expected.ids);
    },
  );
});

describe('the grammar', () => {
  it.each([
    ['{classCode}-{area}{seq:2}', true],
    ['{{literal}}-{seq:3}', true],
    ['{hierarchy.unit.code}/{seq:4}', true],
    ['T-{seq}', true],
    ['', false],
    ['no field', false],
    ['{seq:0}', false],
    ['{seq:13}', false],
    ['{seq:x}', false],
    ['{bad name}', false],
    ['{hierarchy.nope.code}', false],
    ['{seq', false],
    ['seq}', false],
    ['{seq:2:3}', false],
  ])('parseTagFormat(%j) is %s', (format, valid) => {
    expect(parseTagFormat(format).ok).toBe(valid);
  });

  it('writes braces with {{ and }} and pads a padded field to its width, refusing a value that does not fit', () => {
    const parsed = parseTagFormat('{{x}}-{seq:3}');
    expect(parsed.ok && generateTag(parsed.parts, () => 7)).toEqual({ ok: true, tag: '{x}-007' });
    expect(parsed.ok && generateTag(parsed.parts, () => 1234)).toMatchObject({ ok: false, code: 'DAT_TAG_FORMAT' });
    expect(parsed.ok && generateTag(parsed.parts, () => -1)).toMatchObject({ ok: false, code: 'DAT_TAG_FORMAT' });
    expect(parsed.ok && generateTag(parsed.parts, () => '012')).toEqual({ ok: true, tag: '{x}-012' });
    expect(parsed.ok && generateTag(parsed.parts, () => undefined)).toMatchObject({
      ok: false,
      code: 'DAT_TAG_FIELD_MISSING',
      field: 'seq',
    });
  });

  it('nextSequence is max + 1 over the tags with the same other fields and refuses a full field', () => {
    const doc = packDocument();
    const model = getPlantData(doc);
    const unit = Object.values(model.hierarchy).find((node) => node.code === 'U10')?.id as string;
    const env = envOf(model, resolvedOrNull(model, 'EquipP') as NonNullable<ReturnType<typeof resolvedOrNull>>, {
      hierarchyId: unit,
      tagFields: {},
      properties: {},
    });
    expect(nextSequence(env, [])).toEqual({ ok: true, sequence: 1, field: 'seq' });
    expect(nextSequence(env, ['P-101', 'P-105', 'T-120', 'P-203'])).toEqual({ ok: true, sequence: 6, field: 'seq' });
    expect(nextSequence(env, ['P-199'])).toMatchObject({ ok: false, code: 'DAT_TAG_FORMAT' });
  });

  it('sorts tags in natural order', () => {
    expect(['P-10', 'P-2', 'P-1', 'T-1', 'P-010'].sort(naturalCompare)).toEqual(['P-1', 'P-2', 'P-10', 'P-010', 'T-1']);
    expect(naturalCompare('A', 'A')).toBe(0);
    expect(naturalCompare('A1', 'A')).toBeGreaterThan(0);
    expect(naturalCompare('A', 'A1')).toBeLessThan(0);
    expect(naturalCompare('1A', 'A')).toBeLessThan(0);
  });
});
