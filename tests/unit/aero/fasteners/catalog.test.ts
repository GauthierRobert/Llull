/** 08 MAT M5: catalogue import, listing and part-number decoding (VC-MAT-06, VC-MAT-20, VC-MAT-24 FAST_PART_NUMBER_UNKNOWN). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { expectPure } from '../../../helpers/expectNoOp';
import { acmeCatalogFile, dataOf, docWith, ok, readValidation, sampleCatalogFile } from './fixtures';

interface Checkpoint {
  id: string;
  expected: { grip_in: number; length_in: number };
  published: { grip_in: number; length_in: number };
  tolerance: { absolute_in: number };
}

const checkpoints = (readValidation('expected_results.json') as { catalogCheckpoints: Checkpoint[] }).catalogCheckpoints;

describe('import_fastener_catalog', () => {
  it('imports the sample families, records one step and is pure', () => {
    const doc = createEmptyDocument();
    const result = ok(doc, 'import_fastener_catalog', { catalog: sampleCatalogFile() });
    expect(Object.keys(result.document.fasteners?.catalogs ?? {}).sort()).toEqual([
      'HL19',
      'MS20470',
      'MS21042',
      'NAS1149',
      'NAS6203-6220',
    ]);
    expect(result.document.featureHistory.map((step) => step.name)).toEqual(['import_fastener_catalog']);
    expect(dataOf(result)['imported']).toHaveLength(5);
    expectPure(doc, () => execute(doc, 'import_fastener_catalog', { catalog: sampleCatalogFile() }));
  });

  it('is idempotent for identical families and refuses a clash unless replace is set', () => {
    const doc = docWith();
    const again = execute(doc, 'import_fastener_catalog', { catalog: sampleCatalogFile() });
    expect(again.document).toBe(doc);
    expect(again.error).toBeUndefined();

    const changed = sampleCatalogFile();
    (changed['families'] as Array<Record<string, unknown>>)[0] = {
      ...(changed['families'] as Array<Record<string, unknown>>)[0],
      licence: 'company-proprietary',
    };
    const clash = execute(doc, 'import_fastener_catalog', { catalog: changed });
    expect(clash.document).toBe(doc);
    expect(clash.error?.code).toBe('FAST_CATALOG_CONFLICT');
    expect(clash.error?.ids).toEqual(['NAS6203-6220']);
    const replaced = ok(doc, 'import_fastener_catalog', { catalog: changed, replace: true });
    expect(replaced.document.fasteners?.catalogs['NAS6203-6220']?.licence).toBe('company-proprietary');
  });

  const broken = (mutate: (family: Record<string, unknown>) => void): Record<string, unknown> => {
    const file = sampleCatalogFile();
    const family = structuredClone((file['families'] as Array<Record<string, unknown>>)[0]) as Record<string, unknown>;
    mutate(family);
    return { ...file, families: [family] };
  };

  it.each([
    ['a file that is not a catalogue', { format: 'something-else' }, 'FAST_CATALOG_INVALID'],
    ['a grammar without diameterDash', broken((f) => (f['partNumber'] = [{ kind: 'literal', text: 'X' }])), 'FAST_CATALOG_INVALID'],
    ['a family without provenance', broken((f) => delete f['provenance']), 'MAT_PROVENANCE_MISSING'],
    [
      'a dimension unit that does not parse',
      broken((f) => ((f['gripIncrement'] as Record<string, unknown>)['unit'] = 'furlongs')),
      'MAT_UNIT_INVALID',
    ],
    [
      'a dimension in a unit of another dimension',
      broken((f) => ((f['gripIncrement'] as Record<string, unknown>)['unit'] = 'MPa')),
      'MAT_UNIT_DIMENSION',
    ],
    [
      'grip_plus_thread without thread lengths',
      broken((f) => delete (f['sizes'] as Array<Record<string, unknown>>)[0]?.['threadLength']),
      'FAST_CATALOG_INVALID',
    ],
    ['duplicate size dashes', broken((f) => (f['sizes'] as unknown[]).push((f['sizes'] as unknown[])[0])), 'FAST_CATALOG_INVALID'],
    ['an unknown licence flag', broken((f) => (f['licence'] = 'free-for-all')), 'FAST_CATALOG_INVALID'],
  ])('refuses %s with %s and leaves the document unchanged', (_what, catalog, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_fastener_catalog', { catalog });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error?.code).toBe(code);
    expect(result.error?.remediation).not.toBe('');
  });

  it.each([
    ['a zero grip increment', 'gripIncrement', 0],
    ['a negative grip increment', 'gripIncrement', -0.0625],
    ['a zero length step', 'lengthRule', 0],
    ['a negative length step', 'lengthRule', -0.0625],
  ])('refuses %s as FAST_CATALOG_INVALID', (_what, field, value) => {
    const file = sampleCatalogFile();
    const families = file['families'] as Array<Record<string, unknown>>;
    const pick = (f: Record<string, unknown>): boolean =>
      field === 'lengthRule'
        ? (f['lengthRule'] as { kind?: string } | undefined)?.kind === 'stack_plus_k_d'
        : f['gripIncrement'] !== undefined;
    const family = structuredClone(families.find(pick)) as Record<string, unknown>;
    const holder = field === 'lengthRule' ? (family['lengthRule'] as Record<string, unknown>)['step'] : family['gripIncrement'];
    (holder as Record<string, unknown>)['value'] = value;
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_fastener_catalog', { catalog: { ...file, families: [family] } });
    expect(result.document).toBe(doc);
    expect(result.error?.code).toBe('FAST_CATALOG_INVALID');
  });

  it('refuses a licensed-no-redistribution family embedded in the document', () => {
    const file = sampleCatalogFile();
    const family = { ...(file['families'] as Array<Record<string, unknown>>)[0], licence: 'licensed-no-redistribution' };
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_fastener_catalog', { catalog: { ...file, families: [family] } });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.error?.code).toBe('FAST_LICENCE_EMBED_FORBIDDEN');
    expect(result.error?.ids).toEqual(['NAS6203-6220']);
    expect(result.error?.remediation).toContain('private library');
  });

  it('VC-MAT-20: a synthetic metric family imports and works without a code change', () => {
    const doc = docWith(acmeCatalogFile());
    const decoded = dataOf(execute(doc, 'decode_part_number', { partNumber: 'AC100-M6x12' }))['matches'] as Array<Record<string, unknown>>;
    expect(decoded[0]).toMatchObject({ family: 'ACME-100', fields: { diameterDash: 6, gripDash: 12 } });
    expect(decoded[0]?.['gripIn']).toBeCloseTo(12 / 25.4, 6);
    const selected = ok(doc, 'select_fastener', { family: 'ACME-100', diameterDash: '6', stack: { value: 12, unit: 'mm' } });
    expect(dataOf(selected)).toMatchObject({ ok: true, partNumber: 'AC100-M6x12', gripDash: 12 });
    expect(dataOf(selected)['lengthIn']).toBeCloseTo(26 / 25.4, 5);
    const shimless = execute(doc, 'select_fastener', { family: 'ACME-100', diameterDash: '6', stack: { value: 11.5, unit: 'mm' } });
    expect(shimless.error?.code).toBe('FAST_WASHER_GAP');
    const listed = dataOf(execute(doc, 'list_fastener_families', {}))['families'] as Array<Record<string, unknown>>;
    expect(listed.map((family) => family['id'])).toEqual(['ACME-100']);
  });
});

describe('list_fastener_families', () => {
  it('lists families with sizes, filters by kind and reports an empty catalogue', () => {
    const doc = docWith();
    const all = dataOf(execute(doc, 'list_fastener_families', {}))['families'] as Array<{
      id: string;
      sizes: Array<{ dash: string; diameterIn: number }>;
    }>;
    expect(all.map((family) => family.id)).toContain('NAS6203-6220');
    expect(all.find((family) => family.id === 'NAS6203-6220')?.sizes.map((size) => size.dash)).toEqual(['3', '4', '5', '6']);
    expect(all.find((family) => family.id === 'NAS6203-6220')?.sizes[0]?.diameterIn).toBe(0.1875);
    const nuts = dataOf(execute(doc, 'list_fastener_families', { kind: 'nut' }))['families'] as Array<{ id: string }>;
    expect(nuts.map((family) => family.id)).toEqual(['MS21042']);
    const empty = execute(createEmptyDocument(), 'list_fastener_families', {});
    expect(dataOf(empty)['families']).toEqual([]);
    expect(empty.summary).toContain('no families');
    expectPure(doc, () => execute(doc, 'list_fastener_families', {}));
  });
});

describe('decode_part_number', () => {
  const doc = docWith();

  it.each(checkpoints)('VC-MAT-06 $id: grip and length within 0.001 in of the published value', (checkpoint) => {
    const partNumber = checkpoint.id.replace('VC-MAT-06/', '');
    const match = (dataOf(execute(doc, 'decode_part_number', { partNumber }))['matches'] as Array<Record<string, number>>)[0] as Record<
      string,
      number
    >;
    const tolerance = checkpoint.tolerance.absolute_in;
    expect(Math.abs((match['gripIn'] as number) - checkpoint.published.grip_in)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs((match['lengthIn'] as number) - checkpoint.published.length_in)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs((match['gripIn'] as number) - checkpoint.expected.grip_in)).toBeLessThanOrEqual(tolerance);
    expect(Math.abs((match['lengthIn'] as number) - checkpoint.expected.length_in)).toBeLessThanOrEqual(tolerance);
  });

  it('decodes rivets, Hi-Lok pins, nuts and washers with code meanings', () => {
    const decode = (partNumber: string): Record<string, unknown> =>
      (dataOf(execute(doc, 'decode_part_number', { partNumber }))['matches'] as Array<Record<string, unknown>>)[0] as Record<
        string,
        unknown
      >;
    expect(decode('MS20470AD4-5')).toMatchObject({
      family: 'MS20470',
      diameterIn: 0.125,
      lengthIn: 0.3125,
      codes: { material: { code: 'AD' } },
    });
    expect(decode('HL19-8-10')).toMatchObject({ family: 'HL19', gripRangeIn: [0.5625, 0.625], diameterIn: 0.25 });
    expect(decode('MS21042L3')).toMatchObject({ family: 'MS21042', kind: 'nut', sizeKnown: true });
    expect(decode('NAS1149F0332P')).toMatchObject({ family: 'NAS1149', kind: 'washer', fields: { thickness: 32 }, thicknessIn: 0.032 });
    expect(decode('ms20470ad4-5')['partNumber']).toBe('ms20470ad4-5');
  });

  it('VC-MAT-24: an unknown part number returns no matches and FAST_PART_NUMBER_UNKNOWN', () => {
    const result = execute(doc, 'decode_part_number', { partNumber: 'XYZ123' });
    expect(result.document).toBe(doc);
    expect(dataOf(result)['matches']).toEqual([]);
    expect(result.error?.code).toBe('FAST_PART_NUMBER_UNKNOWN');
    expect(result.error?.remediation).not.toBe('');
    expect(result.error?.ids).toEqual(['XYZ123']);
  });
});
