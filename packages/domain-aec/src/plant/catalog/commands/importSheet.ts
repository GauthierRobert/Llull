/** `import_piping_catalog_sheet` (plant 01 PSC M5): a catalogue from a CSV sheet (the llull export or a mapped sheet of another tool). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { LICENCE_FLAGS } from '@core/model/materialLibrary';
import { refuse } from '../codes';
import { parseCatalogFile } from '../file';
import { catalogFileFromSheet, type CatalogSheetOrigin, type SheetProblem } from '../sheetImport';
import { readSheet, renameHeaders } from '../sheetRead';
import { storeCatalog } from './storeCatalog';

const provenanceParam = z
  .object({
    sourceId: z.string().min(1).describe('Source id.').optional(),
    citation: z.string().min(1).describe('Citation of the source.').optional(),
    url: z.string().describe('URL of the source.').optional(),
    accessed: z.string().describe('Date the source was accessed.').optional(),
  })
  .strict();

/** The sheet row of a file-parser path such as `families.1.sizes.3.outsideDiameter`, or null. */
function originRow(path: string, origin: CatalogSheetOrigin): number | null {
  const match = /^families\.(\d+)\.sizes\.(\d+)/.exec(path);
  return match === null ? null : (origin.rows[Number(match[1])]?.[Number(match[2])] ?? null);
}

/**
 * @affects plant.catalog.catalogs[catalogId] (document slice; the bundled catalogue is never written)
 * @invariant the sheet becomes a llull-piping-catalog file object and goes through the same parser as import_piping_catalog (provenance, units, family schemas, licence); export_piping_catalog format csv then this command reproduces values and keys; a sheet never raises trust: the verified column is ignored and every imported value is unverified (JSON import is the lossless way to carry verified)
 * @failure unreadable / oversized sheet, missing column, hostile header, ragged row, non-numeric cell -> PSC_CATALOG_INVALID (paths name the row); value without provenance -> PSC_PROVENANCE_MISSING; unit not mm / in -> PSC_UNIT_INVALID; licensed-no-redistribution -> PSC_LICENCE_EMBED_FORBIDDEN; id clash -> PSC_CATALOG_CONFLICT
 */
export const importPipingCatalogSheet = defineCommand({
  name: 'import_piping_catalog_sheet',
  description:
    'Import a piping component catalogue from a CSV sheet: the text of export_piping_catalog format csv (one row per size) or a sheet of another tool. ' +
    'Columns: family, type (pipe, elbow90 …), standard, size ("NPS 4" or "DN 100"), smallSize?, schedule?, class?, pn?, facing?, dimensionalStandard?, radius?, ends? (space separated), ' +
    'sourceId? / citation? / url? / accessed? (provenance of the row), then one numeric column per dimension (outsideDiameter, wall, centreToEnd, boltCount …; a blank cell means the size has no such value; ' +
    'prefix dim. when a dimension is named like a fixed column), and verified? (an output of the export: IGNORED on import, every sheet value is unverified because a sheet never raises trust; use import_piping_catalog with verified flags for verified data). Values are in unit (mm default, or in; counts are not scaled). ' +
    'A row without provenance in the sheet takes the provenance param; a value with neither is refused (PSC_PROVENANCE_MISSING). Use columns to map a sheet from another tool: { "family": "Part Family", "size": "Nominal Size" }. ' +
    'Cells are read as text: a value starting with = + - @ is never evaluated, and the leading apostrophe our CSV export adds to such a text is removed. ' +
    'Refuses by row: missing column, ragged row, non-numeric dimension, bad size, family rows that disagree on type / standard / radius / ends. Licence licensed-no-redistribution is refused. ' +
    'Next: check_piping_catalog, lookup_piping_component.',
  params: z.object({
    sheet: z.string().min(1).describe('The CSV text (comma, semicolon or tab separated; first record = header; at most 20 000 rows).'),
    catalogId: z
      .string()
      .describe('Id of the catalogue to create: letters, digits, dot, underscore, hyphen (llull-open-piping is reserved).'),
    licence: z.enum(LICENCE_FLAGS).describe('Licence of the data (licensed-no-redistribution is refused: use a private library).'),
    version: z.string().min(1).describe('Catalogue version. Default "1".').optional(),
    title: z.string().describe('Human title.').optional(),
    unit: z.string().describe('Length unit of the dimension columns: "mm" (default) or "in".').optional(),
    provenance: provenanceParam.describe('Provenance of every row that has none of its own (citation or sourceId).').optional(),
    columns: z
      .record(z.string(), z.string())
      .describe(
        'Map of our column name to the column name in the sheet, e.g. { "family": "Part Family" }; unmapped columns keep their name.',
      )
      .optional(),
    replace: z.boolean().describe('Overwrite a catalogue with the same id but different content. Default false.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[], issues?: readonly unknown[]): CommandResult => ({
      ...refuse(doc, 'import_piping_catalog_sheet', code, message, [], paths),
      ...(issues === undefined ? {} : { data: { issues } }),
    });
    const read = readSheet(params.sheet);
    if ('failure' in read) return fail('PSC_CATALOG_INVALID', read.failure.message, [`sheet:row ${read.failure.line}`]);
    const renamed = renameHeaders(read.sheet, params.columns);
    if ('failure' in renamed) return fail('PSC_CATALOG_INVALID', renamed.failure.message, ['columns']);
    const built = catalogFileFromSheet(renamed.sheet, {
      id: params.catalogId,
      version: params.version,
      title: params.title,
      licence: params.licence,
      unit: params.unit,
      provenance: params.provenance,
    });
    if ('problems' in built) {
      const list: readonly SheetProblem[] = built.problems.slice(0, 50);
      const first = list[0];
      return fail(
        'PSC_CATALOG_INVALID',
        `${built.problems.length} problem(s), first: row ${first?.row}${first?.column === undefined ? '' : ` column ${first.column}`}: ${first?.message}`,
        list.map((problem) => `sheet:row ${problem.row}${problem.column === undefined ? '' : `:${problem.column}`}`),
        list,
      );
    }
    const parsed = parseCatalogFile(built.file);
    if ('issues' in parsed) {
      const rowed = parsed.issues.map((issue) => {
        const row = originRow(issue.path, built.origin);
        return row === null ? issue : { ...issue, message: `${issue.message} (sheet row ${row})`, row };
      });
      return fail(
        parsed.issues[0]?.code ?? 'PSC_CATALOG_INVALID',
        `${parsed.issues.length} problem(s), first: ${rowed[0]?.message ?? 'invalid sheet'}`,
        parsed.issues.map((issue) => issue.path),
        rowed,
      );
    }
    return storeCatalog(doc, 'import_piping_catalog_sheet', parsed.catalog, params.replace ?? false);
  },
});
