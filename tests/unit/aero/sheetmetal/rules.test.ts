import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import type { SheetMetalRule } from '@core/model/sheetMetal';
import { RULE, apply, expectRefusal, ok } from './helpers';

const empty = createEmptyDocument();
const rowOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  material: 'TEST-ALLOY',
  temper: 'T0',
  thickness: 0.8,
  minInsideRadius: 2,
  units: 'mm',
  bendAngle: 90,
  source: 'synthetic test row (not engineering data)',
  ...extra,
});

describe('create_sheet_metal_rule', () => {
  it('stores a rule with a single K-factor and no invented thresholds', () => {
    const result = ok(empty, 'create_sheet_metal_rule', RULE);
    const rule = result.document.sheetMetal?.rules[RULE.name] as SheetMetalRule;
    expect(rule).toMatchObject({ thickness: 1.6, insideRadius: 4.8, material: '2024-T3', temper: 'T3' });
    expect(rule.k).toEqual({ standard: 'ansi', value: 0.44 });
    expect(rule.thresholds).toBeUndefined();
    expect(result.summary).toContain('K 0.44');
  });

  it('stores a K table, sourced thresholds (unverified by default) and relief', () => {
    const doc = apply(empty, 'create_sheet_metal_rule', {
      name: 'tabled',
      material: 'X',
      thickness: 1,
      insideRadius: 2,
      kTable: {
        rows: [
          { rOverT: 1, k: 0.4 },
          { rOverT: 3, k: 0.44 },
        ],
        source: 'shop chart',
      },
      thresholds: {
        holeToBend: { value: 3, source: 'company rule 7' },
        minFlange: { value: 6, source: 'handbook', verification: 'verified' },
      },
      relief: { type: 'rectangular', widthRatio: 0.5, depthExtra: 0.2 },
      allowSharpBends: true,
    });
    const rule = doc.sheetMetal?.rules['tabled'] as SheetMetalRule;
    expect('table' in rule.k && rule.k.verification).toBe('unverified');
    expect(rule.thresholds?.holeToBend).toEqual({ value: 3, source: 'company rule 7', verification: 'unverified' });
    expect(rule.thresholds?.minFlange?.verification).toBe('verified');
    expect(rule.relief).toEqual({ type: 'rectangular', widthRatio: 0.5, depthExtra: 0.2 });
    expect(rule.allowSharpBends).toBe(true);
  });

  it('refuses a missing K-factor, an out-of-range K and both at once', () => {
    const { kFactor: _omit, ...noK } = RULE;
    void _omit;
    expectRefusal(empty, 'create_sheet_metal_rule', noK, 'FTR_K_FACTOR_MISSING', 'kFactor');
    expectRefusal(empty, 'create_sheet_metal_rule', { ...RULE, kFactor: 0.7 }, 'FTR_K_FACTOR_OUT_OF_RANGE', 'kFactor');
    expectRefusal(
      empty,
      'create_sheet_metal_rule',
      { ...noK, kFactor: 0.9, kFactorStandard: 'din', kTable: { rows: [{ rOverT: 1, k: 0.4 }], source: 's' } },
      'FTR_PARAM_INVALID',
    );
    expectRefusal(empty, 'create_sheet_metal_rule', { ...noK, kTable: { rows: [], source: 's' } }, 'FTR_K_FACTOR_MISSING', 'kTable.rows');
    expectRefusal(
      empty,
      'create_sheet_metal_rule',
      { ...noK, kTable: { rows: [{ rOverT: 1, k: 0.9 }], source: 's' } },
      'FTR_K_FACTOR_OUT_OF_RANGE',
      'kTable.rows.0',
    );
    expectRefusal(
      empty,
      'create_sheet_metal_rule',
      { ...noK, kTable: { rows: [{ rOverT: 1, k: 0.4 }], source: ' ' } },
      'FTR_TABLE_ROW_NO_SOURCE',
      'kTable.source',
    );
  });

  it('refuses bad numbers, duplicate names and unsourced thresholds', () => {
    expectRefusal(empty, 'create_sheet_metal_rule', { ...RULE, thickness: 0 }, 'FTR_PARAM_INVALID', 'thickness');
    expectRefusal(empty, 'create_sheet_metal_rule', { ...RULE, insideRadius: -1 }, 'FTR_PARAM_INVALID', 'insideRadius');
    expectRefusal(empty, 'create_sheet_metal_rule', { ...RULE, name: ' ' }, 'FTR_PARAM_INVALID', 'name');
    expectRefusal(apply(empty, 'create_sheet_metal_rule', RULE), 'create_sheet_metal_rule', RULE, 'FTR_PARAM_INVALID', 'name');
    expectRefusal(
      empty,
      'create_sheet_metal_rule',
      { ...RULE, thresholds: { holeToEdge: { value: 2, source: '' } } },
      'FTR_PARAM_INVALID',
      'thresholds.holeToEdge',
    );
  });

  it('is pure', () => {
    const before = JSON.stringify(empty);
    execute(empty, 'create_sheet_metal_rule', RULE);
    expect(JSON.stringify(empty)).toBe(before);
  });
});

describe('import_bend_radius_table', () => {
  it('imports rows, defaults verification to unverified and replaces rows with the same key', () => {
    const first = ok(empty, 'import_bend_radius_table', { rows: [rowOf()] });
    expect(first.document.sheetMetal?.radiusTable[0]?.verification).toBe('unverified');
    const second = apply(first.document, 'import_bend_radius_table', {
      rows: [rowOf({ minInsideRadius: 2.5, verification: 'verified' }), rowOf({ thickness: 1.2, minInsideRadius: 3 })],
    });
    const table = second.sheetMetal?.radiusTable ?? [];
    expect(table).toHaveLength(2);
    expect(table.find((row) => row.thickness === 0.8)).toMatchObject({ minInsideRadius: 2.5, verification: 'verified' });
    expect(first.summary).toContain('1 row(s)');
  });

  it('imports CSV text', () => {
    const csv = [
      'material,temper,thickness,minInsideRadius,units,bendAngle,source,verification',
      'AL,T3,0.040,0.125,in,90,"AC 43.13-1B Table 4-6 (test copy)",unverified',
      'AL,T3,1.0,2.0,mm,90,shop,verified',
    ].join('\n');
    const doc = apply(empty, 'import_bend_radius_table', { csv });
    expect(doc.sheetMetal?.radiusTable).toHaveLength(2);
    expect(doc.sheetMetal?.radiusTable[0]).toMatchObject({ units: 'in', thickness: 0.04, minInsideRadius: 0.125, bendAngle: 90 });
    expect(doc.sheetMetal?.radiusTable[1]?.verification).toBe('verified');
  });

  it('refuses a row without source with the offending path (VC-FTR-37)', () => {
    const { source: _source, ...noSource } = rowOf();
    void _source;
    expectRefusal(empty, 'import_bend_radius_table', { rows: [rowOf(), noSource] }, 'FTR_TABLE_ROW_NO_SOURCE', 'rows[1].source');
    expectRefusal(empty, 'import_bend_radius_table', { rows: [rowOf({ source: '  ' })] }, 'FTR_TABLE_ROW_NO_SOURCE', 'rows[0].source');
    expectRefusal(
      empty,
      'import_bend_radius_table',
      { csv: 'material,temper,thickness,minInsideRadius,units,bendAngle,source\nA,T,1,1,mm,90,' },
      'FTR_TABLE_ROW_NO_SOURCE',
      'csv.rows[0].source',
    );
  });

  it('refuses bad numbers, empty input and both inputs', () => {
    expectRefusal(empty, 'import_bend_radius_table', { rows: [rowOf({ thickness: 0 })] }, 'FTR_PARAM_INVALID', 'rows[0]');
    expectRefusal(empty, 'import_bend_radius_table', { rows: [rowOf({ minInsideRadius: -1 })] }, 'FTR_PARAM_INVALID');
    expectRefusal(empty, 'import_bend_radius_table', { rows: [] }, 'FTR_PARAM_INVALID');
    expectRefusal(empty, 'import_bend_radius_table', {}, 'FTR_PARAM_INVALID');
    expectRefusal(empty, 'import_bend_radius_table', { rows: [rowOf()], csv: 'x' }, 'FTR_PARAM_INVALID');
  });

  it('is pure', () => {
    const before = JSON.stringify(empty);
    execute(empty, 'import_bend_radius_table', { rows: [rowOf()] });
    expect(JSON.stringify(empty)).toBe(before);
  });
});
