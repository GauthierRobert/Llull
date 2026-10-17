import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { BendRadiusRow, KFactorSpec, SheetMetalRule, SheetRuleThreshold, SourcedValue, Verification } from '@core/model/sheetMetal';
import { getModel, withModel } from '../graph';
import { fixed, refuse } from '../result';
import { radiusRowId } from '../rules';

const thresholdField = z.object({
  value: z.number().describe('Threshold value in the document length unit (ratio for maxDepthRatio); >= 0.'),
  source: z.string().describe('Where the value comes from (standard, handbook or company rule with edition); mandatory.'),
  verification: z
    .enum(['verified', 'unverified'])
    .optional()
    .describe("'verified' only after dual-review transcription from the cited source; default 'unverified'."),
});

const THRESHOLDS: readonly SheetRuleThreshold[] = ['holeToBend', 'holeToEdge', 'minFlange', 'minLand', 'maxDepthRatio'];

type ThresholdParam = z.infer<typeof thresholdField>;

function sourced(param: ThresholdParam): SourcedValue {
  return { value: param.value, source: param.source, verification: param.verification ?? 'unverified' };
}

/**
 * @affects sets sheetMetal.rules[name]; no entity changes
 * @invariant exactly one of kFactor / kTable; no built-in thresholds (AF-30/31); K ranges ANSI (0, 0.5], DIN (0, 1]
 * @failure missing K (FTR_K_FACTOR_MISSING), K out of range, duplicate name, non-positive thickness, negative radius, threshold without source -> rejected with error.code
 */
export const createSheetMetalRule = defineCommand({
  name: 'create_sheet_metal_rule',
  description:
    'Define a sheet-metal rule: material/temper label, thickness T, default inside radius R and the K-factor (one dimensionless kFactor, or a kTable of r/T -> K rows with a source; interpolated linearly in r/T and clamped at both ends). ' +
    'All lengths are in the document length unit. Nothing is defaulted: kFactor/kTable and insideRadius must be given (refusal FTR_K_FACTOR_MISSING / FTR_K_FACTOR_OUT_OF_RANGE: ANSI 0 < K <= 0.5, DIN 0 < K <= 1, DIN K = 2 x ANSI K). ' +
    'Design-rule thresholds (hole-to-bend, hole-to-edge, minimum flange, minimum land, depth ratio) are optional and each needs a source; check_sheet_metal reports the ones that are missing. ' +
    "A table, threshold or radius row marked 'unverified' (the default) flags every result computed from it. Next: import_bend_radius_table, then add_sheet_metal_base.",
  params: z.object({
    name: z.string().describe('Unique rule name, referenced by add_sheet_metal_base (e.g. "AL2024-T3 1.6").'),
    material: z.string().describe('Material label (e.g. 2024); with temper it selects the minimum-radius row. Text, no unit.'),
    temper: z.string().optional().describe('Temper label (e.g. T3). Without it no radius-table row can match. Text, no unit.'),
    thickness: z.number().describe('Sheet thickness T in the document length unit; must be > 0.'),
    insideRadius: z
      .number()
      .describe('Default inside bend radius R in the document length unit; >= 0 (0 is a sharp bend, forbidden unless allowSharpBends).'),
    kFactor: z
      .number()
      .optional()
      .describe('Single K-factor (dimensionless, neutral-axis offset / T). ANSI 0 < K <= 0.5; DIN 0 < K <= 1. Give this OR kTable.'),
    kTable: z
      .object({
        rows: z
          .array(
            z.object({
              rOverT: z.number().describe('Inside radius / thickness (dimensionless).'),
              k: z.number().describe('K-factor at that r/T (dimensionless).'),
            }),
          )
          .describe('At least one {rOverT, k} row.'),
        source: z.string().describe('Where the table comes from (mandatory).'),
        verification: z.enum(['verified', 'unverified']).optional().describe("Default 'unverified'."),
      })
      .optional()
      .describe('K-factor table (dimensionless K versus r/T). Give this OR kFactor.'),
    kFactorStandard: z
      .enum(['ansi', 'din'])
      .optional()
      .describe(
        "Convention of kFactor / kTable K values (dimensionless): 'ansi' (default) or 'din' (K_din = 2 x K_ansi, converted when used).",
      ),
    thresholds: z
      .object({
        holeToBend: thresholdField.optional().describe('Minimum distance hole edge to bend tangent line (document length unit).'),
        holeToEdge: thresholdField.optional().describe('Minimum distance hole edge to part edge (document length unit).'),
        minFlange: thresholdField.optional().describe('Minimum flange flat length (document length unit).'),
        minLand: thresholdField.optional().describe('Minimum countersink land (document length unit).'),
        maxDepthRatio: thresholdField.optional().describe('Maximum hole depth / diameter (dimensionless).'),
      })
      .optional()
      .describe('Sourced design-rule thresholds; absent ones are reported by check_sheet_metal, never assumed.'),
    relief: z
      .object({
        type: z.enum(['rectangular', 'obround', 'none']).describe('Relief shape asked for at free bend ends.'),
        widthRatio: z.number().describe('Relief width as a multiple of thickness T (dimensionless).'),
        depthExtra: z
          .number()
          .optional()
          .describe('Extra relief depth beyond R + T in the document length unit; omitted = 0 (reported as a named default).'),
      })
      .optional()
      .describe('Relief the check expects where a bend ends at a free edge.'),
    allowSharpBends: z
      .boolean()
      .optional()
      .describe('Allow inside radius 0 (default false: add_flange refuses R = 0, FTR_SHARP_BEND_FORBIDDEN).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, paths: string[]): CommandResult =>
      refuse(doc, 'create_sheet_metal_rule', code, why, fix, { paths });
    const model = getModel(doc);
    const { name, thickness, insideRadius, kFactor, kTable } = params;
    const standard = params.kFactorStandard ?? 'ansi';
    if (name.trim() === '') return fail('FTR_PARAM_INVALID', 'name is empty', 'Give a rule name.', ['name']);
    if (model.rules[name] !== undefined) return fail('FTR_PARAM_INVALID', `rule "${name}" already exists`, 'Use another name.', ['name']);
    if (!(thickness > 0))
      return fail(
        'FTR_PARAM_INVALID',
        `thickness must be > 0 (got ${thickness})`,
        'Give the sheet thickness in the document length unit.',
        ['thickness'],
      );
    if (!(insideRadius >= 0))
      return fail('FTR_PARAM_INVALID', `insideRadius must be >= 0 (got ${insideRadius})`, 'Give R >= 0 in the document length unit.', [
        'insideRadius',
      ]);
    if (kFactor === undefined && kTable === undefined)
      return fail('FTR_K_FACTOR_MISSING', 'neither kFactor nor kTable given', 'Give kFactor (ANSI 0-0.5) or kTable.', ['kFactor']);
    if (kFactor !== undefined && kTable !== undefined)
      return fail('FTR_PARAM_INVALID', 'give kFactor OR kTable, not both', 'Remove one of them.', ['kFactor', 'kTable']);
    const limit = standard === 'din' ? 1 : 0.5;
    const outOfRange = (k: number): boolean => !(k > 0 && k <= limit);
    const rangeFix = 'ANSI K is neutral-axis offset / T, 0 < K <= 0.5 (DIN = 2 x ANSI).';
    if (kFactor !== undefined && outOfRange(kFactor))
      return fail('FTR_K_FACTOR_OUT_OF_RANGE', `kFactor ${kFactor} is outside (0, ${limit}]`, rangeFix, ['kFactor']);
    if (kTable !== undefined) {
      if (kTable.rows.length === 0)
        return fail('FTR_K_FACTOR_MISSING', 'kTable has no rows', 'Give at least one {rOverT, k} row.', ['kTable.rows']);
      if (kTable.source.trim() === '')
        return fail('FTR_TABLE_ROW_NO_SOURCE', 'kTable has no source', 'Every table needs its source and edition.', ['kTable.source']);
      const bad = kTable.rows.findIndex((row) => outOfRange(row.k) || !(row.rOverT >= 0));
      if (bad >= 0)
        return fail('FTR_K_FACTOR_OUT_OF_RANGE', `kTable row ${bad} is outside the K range or has negative r/T`, rangeFix, [
          `kTable.rows.${bad}`,
        ]);
    }
    const thresholds: Partial<Record<SheetRuleThreshold, SourcedValue>> = {};
    for (const key of THRESHOLDS) {
      const entry = params.thresholds?.[key];
      if (entry === undefined) continue;
      if (entry.source.trim() === '' || !(entry.value >= 0))
        return fail(
          'FTR_PARAM_INVALID',
          `threshold ${key} needs a source and a value >= 0`,
          'Give { value, source } for every threshold.',
          [`thresholds.${key}`],
        );
      thresholds[key] = sourced(entry);
    }
    const k: KFactorSpec =
      kTable !== undefined
        ? {
            standard,
            table: kTable.rows.map((row) => ({ rOverT: row.rOverT, k: row.k })),
            source: kTable.source,
            verification: (kTable.verification ?? 'unverified') as Verification,
          }
        : { standard, value: kFactor as number };
    const rule: SheetMetalRule = {
      name,
      material: params.material,
      ...(params.temper !== undefined ? { temper: params.temper } : {}),
      thickness,
      insideRadius,
      k,
      ...(Object.keys(thresholds).length > 0 ? { thresholds } : {}),
      ...(params.relief !== undefined
        ? {
            relief: {
              type: params.relief.type,
              widthRatio: params.relief.widthRatio,
              ...(params.relief.depthExtra !== undefined ? { depthExtra: params.relief.depthExtra } : {}),
            },
          }
        : {}),
      ...(params.allowSharpBends !== undefined ? { allowSharpBends: params.allowSharpBends } : {}),
    };
    const next = withModel(doc, { ...model, rules: { ...model.rules, [name]: rule } });
    return changed(
      next,
      `create_sheet_metal_rule: rule "${name}" T=${fixed(thickness)} R=${fixed(insideRadius)} ${kTable !== undefined ? `K table (${kTable.rows.length} rows, ${kTable.verification ?? 'unverified'})` : `K ${kFactor} (${standard})`}; ${Object.keys(thresholds).length} threshold(s).`,
      [],
    );
  },
});

const rowField = z.object({
  material: z.string().describe('Material label matching the rule material (text).'),
  temper: z.string().describe('Temper label matching the rule temper (text).'),
  thickness: z.number().describe("Sheet thickness the row applies to, in the row's `units` (mm or in)."),
  minInsideRadius: z.number().describe("Minimum inside bend radius, in the row's `units` (mm or in)."),
  units: z.enum(['mm', 'in']).describe("Unit of thickness and minInsideRadius of this row: 'mm' or 'in'."),
  bendAngle: z.number().describe('Bend angle in degrees the row applies to (AC 43.13-1B Table 4-6 rows apply at 90).'),
  source: z
    .string()
    .optional()
    .describe('Mandatory provenance: standard/handbook and edition (a row without it is refused, FTR_TABLE_ROW_NO_SOURCE).'),
  verification: z
    .enum(['verified', 'unverified'])
    .optional()
    .describe("'verified' only after dual-review transcription from the cited source; default 'unverified'."),
});

type RowParam = z.infer<typeof rowField>;

function parseCsv(text: string): RowParam[] {
  const [header, ...lines] = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const columns = (header ?? '').split(',').map((column) => column.trim());
  return lines.map((line) => {
    const cells = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    const at = (column: string): string | undefined => cells[columns.indexOf(column)];
    const units = at('units') === 'in' ? 'in' : 'mm';
    const verification = at('verification');
    const source = at('source');
    return {
      material: at('material') ?? '',
      temper: at('temper') ?? '',
      thickness: Number(at('thickness')),
      minInsideRadius: Number(at('minInsideRadius')),
      units,
      bendAngle: Number(at('bendAngle')),
      ...(source !== undefined && source !== '' ? { source } : {}),
      ...(verification === 'verified' || verification === 'unverified' ? { verification } : {}),
    };
  });
}

/**
 * @affects replaces/adds sheetMetal.radiusTable rows keyed by material, temper, thickness, units, bendAngle; no entity changes
 * @failure a row without source (FTR_TABLE_ROW_NO_SOURCE, path rows.<i>.source) or with a non-positive/non-finite number -> whole import rejected
 */
export const importBendRadiusTable = defineCommand({
  name: 'import_bend_radius_table',
  description:
    'Import minimum-bend-radius rows (material, temper, thickness -> minimum inside radius at a bend angle) that check_sheet_metal and sheet_metal_calc match against. ' +
    "Give `rows` (each row states its own units 'mm' or 'in') or `csv` text with the header material,temper,thickness,minInsideRadius,units,bendAngle,source,verification. " +
    'Every row needs a source (standard/handbook and edition): a row without one refuses the whole import with FTR_TABLE_ROW_NO_SOURCE and the path rows.<i>.source. ' +
    "Rows are 'unverified' unless marked 'verified' (dual-review transcription); results computed from unverified rows are flagged. Rows with the same key replace the earlier ones. Next: create_sheet_metal_rule.",
  params: z.object({
    rows: z.array(rowField).optional().describe('Radius rows; give this OR csv.'),
    csv: z
      .string()
      .optional()
      .describe(
        'CSV text with a header line: material,temper,thickness,minInsideRadius,units,bendAngle,source,verification. Give this OR rows.',
      ),
  }),
  run: (doc, { rows, csv }): CommandResult => {
    if ((rows === undefined) === (csv === undefined))
      return refuse(doc, 'import_bend_radius_table', 'FTR_PARAM_INVALID', 'give exactly one of rows or csv', 'Pass rows or csv.', {
        paths: ['rows', 'csv'],
      });
    const input = rows ?? parseCsv(csv as string);
    if (input.length === 0)
      return refuse(doc, 'import_bend_radius_table', 'FTR_PARAM_INVALID', 'no rows', 'Give at least one row.', {
        paths: [rows === undefined ? 'csv' : 'rows'],
      });
    const base = rows === undefined ? 'csv.rows' : 'rows';
    const missing = input.findIndex((row) => row.source === undefined || row.source.trim() === '');
    if (missing >= 0)
      return refuse(
        doc,
        'import_bend_radius_table',
        'FTR_TABLE_ROW_NO_SOURCE',
        `row ${missing} has no source`,
        'Every row needs its source and edition.',
        { paths: [`${base}[${missing}].source`] },
      );
    const invalid = input.findIndex(
      (row) =>
        !(row.thickness > 0) || !(row.minInsideRadius >= 0) || !Number.isFinite(row.bendAngle) || row.material === '' || row.temper === '',
    );
    if (invalid >= 0)
      return refuse(
        doc,
        'import_bend_radius_table',
        'FTR_PARAM_INVALID',
        `row ${invalid} has a non-positive thickness, negative radius, bad angle or empty material/temper`,
        'Fix the row values.',
        { paths: [`${base}[${invalid}]`] },
      );
    const incoming: BendRadiusRow[] = input.map((row) => ({
      material: row.material,
      temper: row.temper,
      thickness: row.thickness,
      minInsideRadius: row.minInsideRadius,
      units: row.units,
      bendAngle: row.bendAngle,
      source: (row.source as string).trim(),
      verification: row.verification ?? 'unverified',
    }));
    const model = getModel(doc);
    const keys = new Set(incoming.map(radiusRowId));
    const radiusTable = [...model.radiusTable.filter((row) => !keys.has(radiusRowId(row))), ...incoming];
    const unverified = incoming.filter((row) => row.verification === 'unverified').length;
    return changed(
      withModel(doc, { ...model, radiusTable }),
      `import_bend_radius_table: ${incoming.length} row(s) imported (${unverified} unverified); table now has ${radiusTable.length} row(s).`,
      [],
    );
  },
});
