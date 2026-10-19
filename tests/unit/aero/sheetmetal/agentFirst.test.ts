/** Agent-first contract of the sheet-metal commands (TR-FTR-01, 03, 07; AF-02, AF-04, AF-11, AF-33). */
import { describe, expect, it } from 'vitest';
import { execute, getCommand, listCommands, toToolSchemas } from '@core/commands/registry';
import type { ParamItemSpec, ParamSpec } from '@core/commands/types';
import { FTR_CODES } from '@core/model/manufacturing';
import { TOOLSETS } from '@protocol/toolsets';
import { sheetMetalCommands } from '@aero/sheetmetal/catalog';
import { createEmptyDocument } from '@core/model/types';
import { RULE, bracket } from './helpers';

const names = sheetMetalCommands.map((command) => command.name);
const UNIT_WORDS = ['document length unit', 'degrees', 'in `units`', "'mm' or 'in'", 'dimensionless', 'mm or in', 'ratio', 'radians'];

function numericParams(spec: ParamItemSpec, path: string): Array<{ path: string; description: string }> {
  const description = (spec as ParamSpec).description ?? '';
  const numbers = spec.type === 'number' || spec.type === 'integer';
  const arrayOfNumbers = spec.type === 'array' && (spec.items?.type === 'number' || spec.items?.type === 'integer');
  const own = numbers || arrayOfNumbers ? [{ path, description }] : [];
  const children = Object.entries(spec.properties ?? {}).flatMap(([key, child]) => numericParams(child, `${path}.${key}`));
  const items = spec.items === undefined || arrayOfNumbers ? [] : numericParams(spec.items, `${path}[]`);
  return [...own, ...children, ...items];
}

describe('registration', () => {
  it('registers every sheet-metal command once, in the manufacturing toolset', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'sheet_metal_calc',
        'create_sheet_metal_rule',
        'import_bend_radius_table',
        'add_sheet_metal_base',
        'add_flange',
        'add_joggle',
        'add_sheet_cutout',
        'add_relief',
        'flat_pattern',
        'materialize_flat_pattern',
        'check_sheet_metal',
        'export_flat_pattern_dxf',
        'convert_to_sheet_metal',
      ]),
    );
    for (const name of names) {
      expect(getCommand(name), name).toBeDefined();
      expect(TOOLSETS.manufacturing).toContain(name);
      expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
    const schemas = toToolSchemas();
    expect(schemas).toHaveLength(listCommands().length);
    expect(new Set(schemas.map((schema) => schema.name)).size).toBe(schemas.length);
  });

  it('marks queries read-only and the kernel command as requiring a kernel', () => {
    for (const query of ['sheet_metal_calc', 'flat_pattern', 'check_sheet_metal', 'export_flat_pattern_dxf'])
      expect(getCommand(query)?.annotations?.readOnly, query).toBe(true);
    expect(getCommand('convert_to_sheet_metal')?.annotations?.requiresKernel).toBe(true);
  });
});

describe('units in every schema (TR-FTR-01)', () => {
  it.each(names)('%s states a unit for every numeric parameter', (name) => {
    const schema = toToolSchemas().find((entry) => entry.name === name);
    expect(schema).toBeDefined();
    const numeric = Object.entries(schema?.input_schema.properties ?? {}).flatMap(([key, spec]) => numericParams(spec, key));
    for (const { path, description } of numeric)
      expect(
        UNIT_WORDS.some((word) => description.toLowerCase().includes(word.toLowerCase())),
        `${name}.${path}: "${description}"`,
      ).toBe(true);
    expect(schema?.description.length).toBeGreaterThan(80);
  });

  it('sheet_metal_calc requires its units', () => {
    const properties = getCommand('sheet_metal_calc')?.paramsSchema;
    expect(properties?.required).toContain('units');
    expect(properties?.properties['units']?.enum).toEqual(['mm', 'in']);
  });
});

describe('closed set of codes (TR-FTR-03)', () => {
  it('keeps every code of the specification (codes are only ever added)', () => {
    for (const code of [
      'FTR_K_FACTOR_MISSING',
      'FTR_K_FACTOR_OUT_OF_RANGE',
      'FTR_BEND_ANGLE_OUT_OF_RANGE',
      'FTR_SHARP_BEND_FORBIDDEN',
      'FTR_BEND_RADIUS_BELOW_MIN',
      'FTR_BEND_RADIUS_NO_TABLE_ROW',
      'FTR_TABLE_ROW_NO_SOURCE',
      'FTR_RULE_NOT_FOUND',
      'FTR_PART_NOT_FOUND',
      'FTR_PROFILE_NOT_CLOSED',
      'FTR_EDGE_NOT_STRAIGHT',
      'FTR_JOGGLE_OFFSET_TOO_SMALL',
      'FTR_HOLE_TO_BEND_TOO_CLOSE',
      'FTR_HOLE_TO_EDGE_TOO_CLOSE',
      'FTR_FLANGE_TOO_SHORT',
      'FTR_RELIEF_MISSING',
      'FTR_NOT_SHEET_METAL',
      'FTR_NON_DEVELOPABLE',
      'FTR_UNVERIFIED_DATA',
      'FTR_WAIVER_NOT_APPROVED',
      'FTR_NEEDS_EXACT_KERNEL',
      'FTR_RULE_THRESHOLD_MISSING',
    ])
      expect(FTR_CODES).toContain(code);
    expect(new Set(FTR_CODES).size).toBe(FTR_CODES.length);
  });

  it('every refusal carries a code of the set, a remediation and the offending path', () => {
    const doc = createEmptyDocument();
    const { doc: withPart, part } = bracket();
    const refusals = [
      execute(doc, 'sheet_metal_calc', { units: 'mm', thickness: 1.6, insideRadius: 4.8, angle: 90 }),
      execute(doc, 'sheet_metal_calc', { units: 'mm', thickness: 1.6, insideRadius: 4.8, angle: 0, kFactor: 0.4 }),
      execute(doc, 'import_bend_radius_table', {
        rows: [{ material: 'A', temper: 'T', thickness: 1, minInsideRadius: 1, units: 'mm', bendAngle: 90 }],
      }),
      execute(doc, 'add_sheet_metal_base', { profileId: 'x', rule: 'none', side: 'up' }),
      execute(withPart, 'add_flange', {
        id: part,
        edge: { near: [0, 25, 0] },
        angle: 90,
        length: 20,
        lengthReference: 'tangent',
        position: 'material_outside',
        insideRadius: 0,
      }),
      execute(withPart, 'add_joggle', {
        id: part,
        face: { near: [10, 25, 0] },
        line: [
          [5, 0],
          [5, 50],
        ],
        offset: 0.1,
        angle: 45,
        side: 'up',
      }),
      execute(withPart, 'flat_pattern', { id: 'missing' }),
    ];
    for (const result of refusals) {
      expect(result.rejected, result.summary).toBe(true);
      expect(FTR_CODES as readonly string[], result.summary).toContain(result.error?.code);
      expect(result.error?.remediation.length).toBeGreaterThan(5);
      expect(result.summary).toContain(result.error?.code ?? '?');
      expect(result.summary).toContain('Document unchanged');
    }
    expect(refusals.map((result) => result.error?.paths.length).every((length) => (length ?? 0) > 0)).toBe(true);
  });
});

describe('review flags on queries (TR-FTR-07, AF-33)', () => {
  it('flat_pattern, check_sheet_metal, export_flat_pattern_dxf and sheet_metal_calc carry reviewRequired and say "not approved"', () => {
    const { doc, part } = bracket();
    const calls: Array<[string, unknown]> = [
      ['sheet_metal_calc', { units: 'mm', thickness: 1.6, insideRadius: 4.8, angle: 90, kFactor: 0.44 }],
      ['flat_pattern', { id: part }],
      ['check_sheet_metal', { id: part }],
      ['export_flat_pattern_dxf', { id: part }],
    ];
    for (const [name, params] of calls) {
      const result = execute(doc, name, params);
      const data = result.data as { reviewRequired: boolean; reviewReason: string; angleUnit: string; lengthUnit: string };
      expect(data.reviewRequired, name).toBe(true);
      expect(data.reviewReason.length, name).toBeGreaterThan(10);
      expect(data.angleUnit).toBe('deg');
      expect(['mm', 'cm', 'm', 'in', 'ft']).toContain(data.lengthUnit);
      expect(result.summary.toLowerCase(), name).toContain('not approved');
    }
  });

  it('never defaults the K-factor or invents thresholds', () => {
    const { doc } = bracket();
    const rule = doc.sheetMetal?.rules[RULE.name];
    expect(rule?.thresholds).toBeUndefined();
    expect(getCommand('sheet_metal_calc')?.paramsSchema.properties['kFactor']?.description).toContain('never defaulted');
  });
});
