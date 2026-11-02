/** `import_pipe_spec_sheet` (plant 01 PSC M5): a spec from its CSV sheet (the llull export or a Plant 3D style sheet) plus the spec header. */

import { defineCommand, z } from '@core/commands/schema';
import { isRecord } from '@lib/isRecord';
import type { CommandResult } from '@core/commands/types';
import { refuse } from '../../catalog/codes';
import type { SheetProblem } from '../../catalog/sheetImport';
import { readSheet, renameHeaders, type Sheet, type SheetFailure } from '../../catalog/sheetRead';
import { headerShape, insulationRowSchema, parseSpecFile, SPEC_FORMAT, SPEC_ID_PATTERN } from '../file';
import { branchCellsFromSheet, componentsFromSheet } from '../sheetImport';
import { plant3dToSheet } from '../sheetPlant3d';
import { storeImportedSpec } from './storeSpec';

const headerParam = z.object({
  id: z.string().regex(SPEC_ID_PATTERN).describe('Spec id: letters, digits, dot, underscore, hyphen, at most 64.'),
  revision: z.number().int().positive().describe('Revision number of a first import. Default 1.').optional(),
  ...headerShape,
  insulation: z
    .array(insulationRowSchema)
    .describe('Insulation thickness table rows { code, dnMax, tempMaxC, thicknessMm, material }.')
    .optional(),
});

const refusalOf = (failure: SheetFailure): readonly SheetProblem[] => [{ row: failure.line, message: failure.message }];

/**
 * @affects plant.spec.specs[spec.id] (document slice, always a draft; same storage rules as import_pipe_spec)
 * @invariant the sheet becomes a llull-pipe-spec file object and goes through the same parser as import_pipe_spec; export_pipe_spec format csv (sheet + data.branchCsv + data.header) then this command reproduces the spec; the verified column is ignored (it is computed from the catalogues)
 * @failure unreadable / oversized sheet, missing column, hostile header, ragged row, bad size or number, unknown type -> PSC_SPEC_INVALID (paths name the row); duplicate component id -> PSC_SPEC_INVALID; corrosion unit -> PSC_UNIT_INVALID; id clash with different content -> PSC_SPEC_CONFLICT
 */
export const importPipeSpecSheet = defineCommand({
  name: 'import_pipe_spec_sheet',
  description:
    'Import a piping spec from a CSV sheet plus its header. The sheet is the text of export_pipe_spec format csv (one row per component: component, type, from, to ("NPS 2" / "DN 50"), branchFrom, branchTo, ends, class, pn, facing, radius, schedule, ' +
    'scheduleFromPipe, wallMm, priority, catalogRef, standard, commodityCode, description, material, extra (a JSON object of scalar members); verified is ignored) and branchSheet is its data.branchCsv (header, branch, fitting); spec is the header: ' +
    'data.header of the export, or { id, dimensionalStandard, rating, corrosionAllowance, sizeRange, catalogs, ... } as for create_pipe_spec (no default for any safety member). ' +
    'format "plant3d" reads a Plant 3D Spec Editor style CSV instead (the exact export schema is not published: columns are matched by name - Part Category / Part Family, Size, Short Description, End Type, Pressure Class, Schedule, Item Code, Material ... - ' +
    'or by columns { "type": "Part Category" }; one row = one part at one size; typeMap maps your part categories { "Gate Valve": "valveGate" }; catalogRef gives the catalogue family of rows that name none; a column that maps to nothing is kept in the component extra; ' +
    'a value of ends / class / facing / radius that matches no allowed value is kept in extra and counted in data.unmapped; an unknown part category refuses its row). ' +
    'Cells are text: a value starting with = + - @ is never evaluated, the apostrophe our export adds to it is removed. At most 20 000 rows. The spec is stored as a draft. ' +
    'Next: check_pipe_spec, export_pipe_spec.',
  params: z.object({
    sheet: z.string().min(1).describe('The spec sheet CSV text (comma, semicolon or tab; first record = header).'),
    spec: headerParam.describe(
      'The spec header: id, dimensionalStandard, rating, corrosionAllowance, sizeRange, catalogs … (data.header of export_pipe_spec format csv).',
    ),
    branchSheet: z
      .string()
      .min(1)
      .describe('The branch table CSV text (columns header, branch, fitting): data.branchCsv of the export.')
      .optional(),
    format: z
      .enum(['llull', 'plant3d'])
      .describe('llull (default): the export_pipe_spec sheet. plant3d: a Plant 3D Spec Editor style sheet.')
      .optional(),
    columns: z
      .record(z.string(), z.string())
      .describe(
        'Map of our column name to the column name in the sheet, e.g. { "type": "Part Category", "size": "Size" }; unmapped columns keep their name (plant3d: they go to extra).',
      )
      .optional(),
    typeMap: z
      .record(z.string(), z.string())
      .describe('plant3d: part category value of the sheet -> component type (pipe, elbow90, valveGate …).')
      .optional(),
    catalogRef: z
      .string()
      .min(1)
      .describe('plant3d: catalogue family reference for rows without a catalogRef column, e.g. "asme-b16.9".')
      .optional(),
    sizeSystem: z.enum(['NPS', 'DN']).describe('plant3d: system of a bare number in the Size column. Default NPS.').optional(),
    replace: z
      .boolean()
      .describe('Overwrite a spec with the same id but different content (as import_pipe_spec). Default false.')
      .optional(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (problems: readonly SheetProblem[], code = 'PSC_SPEC_INVALID', paths?: readonly string[]): CommandResult => {
      const first = problems[0];
      return {
        ...refuse(
          doc,
          'import_pipe_spec_sheet',
          code,
          `${problems.length} problem(s), first: ${first?.row === undefined ? '' : `row ${first.row}${first.column === undefined ? '' : ` column ${first.column}`}: `}${first?.message}`,
          [],
          paths ??
            problems.slice(0, 50).map((problem) => `sheet:row ${problem.row}${problem.column === undefined ? '' : `:${problem.column}`}`),
        ),
        data: { issues: problems.slice(0, 50) },
      };
    };
    const format = params.format ?? 'llull';
    const read = readSheet(params.sheet);
    if ('failure' in read) return fail(refusalOf(read.failure));
    let sheet: Sheet = read.sheet;
    let unmapped: readonly { readonly column: string; readonly count: number }[] = [];
    if (format === 'plant3d') {
      const converted = plant3dToSheet(
        sheet,
        { sizeSystem: params.sizeSystem ?? 'NPS', typeMap: params.typeMap, catalogRef: params.catalogRef },
        params.columns,
      );
      if ('problems' in converted) return fail(converted.problems);
      sheet = converted.result.sheet;
      unmapped = converted.result.unmapped;
    } else {
      const renamed = renameHeaders(sheet, params.columns);
      if ('failure' in renamed) return fail(refusalOf(renamed.failure));
      sheet = renamed.sheet;
    }
    const built = componentsFromSheet(sheet);
    if ('problems' in built) return fail(built.problems);
    let branchCells: Record<string, Record<string, string>> | undefined;
    if (params.branchSheet !== undefined) {
      const branchRead = readSheet(params.branchSheet, true);
      if ('failure' in branchRead) return fail([{ row: branchRead.failure.line, message: `branchSheet: ${branchRead.failure.message}` }]);
      const cells = branchCellsFromSheet(branchRead.sheet);
      if ('problems' in cells) return fail(cells.problems.map((problem) => ({ ...problem, message: `branchSheet: ${problem.message}` })));
      branchCells = cells.cells;
    }
    const parsed = parseSpecFile({
      ...params.spec,
      format: SPEC_FORMAT,
      schemaVersion: 1,
      components: built.components,
      ...(branchCells === undefined || Object.keys(branchCells).length === 0 ? {} : { branchTable: { cells: branchCells } }),
    });
    if ('issues' in parsed) {
      const issues = parsed.issues.map((issue) => {
        const match = /^components\.(\d+)/.exec(issue.path);
        const row = match === null ? undefined : built.rows[Number(match[1])];
        return row === undefined ? issue : { ...issue, message: `${issue.message} (sheet row ${row})`, row };
      });
      return {
        ...refuse(
          doc,
          'import_pipe_spec_sheet',
          parsed.issues[0]?.code ?? 'PSC_SPEC_INVALID',
          `${issues.length} problem(s), first: ${issues[0]?.message ?? 'invalid spec'}`,
          [],
          issues.map((issue) => issue.path),
        ),
        data: { issues },
      };
    }
    const stored = storeImportedSpec(doc, 'import_pipe_spec_sheet', parsed.spec, params.replace ?? false);
    return {
      ...stored,
      data: {
        ...(isRecord(stored.data) ? stored.data : {}),
        format,
        sheetRows: built.components.length,
        ...(format === 'plant3d' ? { unmapped } : {}),
      },
    };
  },
});
