/** Part-number grammar, tick arithmetic and catalogue validation details of the fastener plugin. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { PartNumberField } from '@aero/fasteners/types';
import { decodeWithGrammar, defaultedCodes, formatWithGrammar } from '@aero/fasteners/partNumber';
import { convertTo, quantityToDoc, ticksToInches, toTicks } from '@aero/fasteners/units';
import { sampleCatalogFile } from './fixtures';

const grammar: PartNumberField[] = [
  { kind: 'literal', text: 'AB.' },
  { kind: 'code', name: 'finish', table: { P: 'plain', PC: 'plated' } },
  { kind: 'int', name: 'diameterDash', width: 2 },
  { kind: 'int', name: 'suffix', optional: true },
];

describe('part-number grammar', () => {
  it('decodes literals, longest-match codes, fixed-width and optional ints (case-insensitively)', () => {
    expect(decodeWithGrammar(grammar, 'AB.PC07')).toEqual({ finish: 'PC', diameterDash: 7 });
    expect(decodeWithGrammar(grammar, 'ab.p0712')).toEqual({ finish: 'P', diameterDash: 7, suffix: 12 });
    expect(decodeWithGrammar(grammar, 'AB.X07')).toBeNull();
    expect(decodeWithGrammar(grammar, 'AB.P7')).toBeNull();
  });

  it('formats back, taking the first code when none is given and refusing a missing required int', () => {
    expect(formatWithGrammar(grammar, { finish: 'PC', diameterDash: 7, suffix: 3 })).toBe('AB.PC073');
    expect(formatWithGrammar(grammar, { diameterDash: 7 })).toBe('AB.P07');
    expect(formatWithGrammar(grammar, { finish: 'P' })).toBeNull();
    expect(defaultedCodes(grammar, { diameterDash: 7 })).toEqual(['finish']);
    expect(defaultedCodes(grammar, { finish: 'P', diameterDash: 7 })).toEqual([]);
  });
});

describe('length ticks', () => {
  it('converts exactly through integer ticks and reports unit errors as null', () => {
    expect(toTicks(0.0625, 'in', 'in')).toBe(62500);
    expect(toTicks(25.4, 'mm', 'in')).toBe(1_000_000);
    expect(ticksToInches(1_000_000, 'in')).toBe(1);
    expect(ticksToInches(25_400_000, 'mm')).toBe(1);
    expect(convertTo(1, 'furlong', 'in')).toBeNull();
    expect(convertTo(1, 'MPa', 'in')).toBeNull();
    expect(toTicks(1, 'furlong', 'in')).toBeNull();
    expect(quantityToDoc({ units: 'in' }, 25.4, 'mm')).toBeCloseTo(1, 12);
    expect(quantityToDoc({ units: 'in' }, 1, 'MPa')).toBeNull();
  });
});

describe('catalogue validation details', () => {
  const family = (change: (f: Record<string, unknown>) => void): Record<string, unknown> => {
    const file = sampleCatalogFile();
    const first = structuredClone((file['families'] as Array<Record<string, unknown>>)[0]) as Record<string, unknown>;
    change(first);
    return { ...file, families: [first] };
  };
  const sizes = (f: Record<string, unknown>): Array<Record<string, unknown>> => f['sizes'] as Array<Record<string, unknown>>;
  const fields = (f: Record<string, unknown>): Array<Record<string, unknown>> => f['partNumber'] as Array<Record<string, unknown>>;

  it.each([
    [
      'an inverted dimension range',
      family((f) => (sizes(f)[0]!['dims'] = { x: { min: 2, max: 1, unit: 'in', provenance: { citation: 'c' } } })),
      'FAST_CATALOG_INVALID',
    ],
    ['a dimension without provenance', family((f) => (sizes(f)[0]!['dims'] = { x: { nominal: 1, unit: 'in' } })), 'MAT_PROVENANCE_MISSING'],
    [
      'a hole diameter without provenance',
      family((f) => (sizes(f)[0]!['holeDiameter'] = { min: 1, max: 2, unit: 'in' })),
      'MAT_PROVENANCE_MISSING',
    ],
    [
      'a mass dimension in a length unit',
      family((f) => (sizes(f)[0]!['dims'] = { mass: { nominal: 1, unit: 'in', provenance: { citation: 'c' } } })),
      'MAT_UNIT_DIMENSION',
    ],
    [
      'an int scale without a unit',
      family((f) => {
        fields(f)[3] = { kind: 'int', name: 'gripDash', scale: 1 };
      }),
      'FAST_CATALOG_INVALID',
    ],
    ['an empty code table', family((f) => fields(f).push({ kind: 'code', name: 'c', table: {} })), 'FAST_CATALOG_INVALID'],
    ['duplicate grammar field names', family((f) => fields(f).push({ kind: 'int', name: 'gripDash' })), 'FAST_CATALOG_INVALID'],
    [
      'gripMode without a gripDash field',
      family((f) => (f['partNumber'] = fields(f).filter((field) => field['name'] !== 'gripDash'))),
      'FAST_CATALOG_INVALID',
    ],
    ['an inverted grip range', family((f) => (f['availableGripDash'] = { min: 9, max: 2 })), 'FAST_CATALOG_INVALID'],
    [
      'a rivet rule without lengthDash',
      family((f) => (f['lengthRule'] = { kind: 'stack_plus_k_d', k: 1.5, round: 'up', step: { value: 0.0625, unit: 'in' } })),
      'FAST_CATALOG_INVALID',
    ],
    [
      'a rivet step in a bad unit',
      family((f) => {
        fields(f).push({ kind: 'int', name: 'lengthDash' });
        f['lengthRule'] = { kind: 'stack_plus_k_d', k: 1.5, round: 'up', step: { value: 1, unit: 'zz' } };
      }),
      'MAT_UNIT_INVALID',
    ],
    ['a catalogue with no families', { format: 'llull-fastener-catalog', schemaVersion: 1, families: [] }, 'FAST_CATALOG_INVALID'],
  ])('refuses %s with %s', (_what, catalog, code) => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'import_fastener_catalog', { catalog });
    expect(result.error?.code).toBe(code);
    expect(result.document).toBe(doc);
    expect(result.error?.paths.length).toBeGreaterThan(0);
  });
});
