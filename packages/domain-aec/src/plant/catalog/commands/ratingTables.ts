/** Rating-table commands (plant 01 PSC M5): `import_rating_table` (mutating) and `export_rating_table` (read-only). Tables live in `doc.plant.catalog.ratingTables`. */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { changed, exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { BUNDLED_RATING_TABLE_ID } from '../bundled';
import { refuse } from '../codes';
import { allRatingTables, ratingTableById } from '../ptRating';
import { parseRatingFile, ratingTableToFile } from '../ratingFile';
import { getCatalogModel, withCatalogModel } from '../store';
import type { RatingTable } from '../types';

const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, '');
const sameBasis = (a: RatingTable, b: RatingTable): boolean =>
  squash(a.standard) === squash(b.standard) && squash(a.materialGroup) === squash(b.materialGroup);

/**
 * @affects plant.catalog.ratingTables[table.id] (document slice; the bundled table is never written)
 * @invariant re-importing identical content changes nothing; different content under an existing id needs replace:true; one table per (standard, material group); stored in bar and degC; every row has provenance and is unverified unless the file says verified
 * @failure bad structure / row without class XOR pn / duplicate row / temperature below minTemperature -> PSC_CATALOG_INVALID (paths); unit not bar|psi, C|F -> PSC_UNIT_INVALID; row without citation or source id -> PSC_PROVENANCE_MISSING; licensed-no-redistribution -> PSC_LICENCE_EMBED_FORBIDDEN; id clash or second table for the same standard and group -> PSC_CATALOG_CONFLICT
 */
export const importRatingTable = defineCommand({
  name: 'import_rating_table',
  description:
    'Import a pressure-temperature rating table into the document (ASME B16.5 other material groups, ASME B16.34, EN 1092-1 PN tables, company tables). ' +
    'The file is { format: "llull-rating-table", schemaVersion: 1, id, standard ("ASME B16.5" | "ASME B16.34" | "EN 1092-1" | "company"), materialGroup ("1.2", "EN 1.0460" …), title?, licence, ' +
    'pressureUnit ("bar" gauge | "psi" psig), temperatureUnit ("C" | "F"), minTemperature (lowest temperature the first row of each class covers), provenance? { citation or sourceId }, ' +
    'rows: [{ class (ASME) or pn (EN), temperature, pressure, verified?, provenance? }] }. Every row needs a provenance (its own or the table one): a value without a source is refused (PSC_PROVENANCE_MISSING). ' +
    'A row is unverified unless the file says verified: true (the file owner vouches for it); psi and degF are converted to bar and degC and rounded to 1e-6. ' +
    'Only ASME B16.5 group 1.1 is bundled: the validation pack holds no source for another table, so these are always your data. One table per standard and material group. ' +
    'Next: pt_rating with tableId, or a spec whose rating names the standard and group (check_pipe_spec with design conditions).',
  params: z.object({
    table: z.record(z.string(), z.unknown()).describe('The rating-table file object (format llull-rating-table, schemaVersion 1).'),
    replace: z
      .boolean()
      .describe('Overwrite a table with the same id but different content. Default false: such a clash is refused (PSC_CATALOG_CONFLICT).')
      .optional(),
  }),
  run: (doc, { table, replace = false }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'import_rating_table', code, message, ids, paths);
    const parsed = parseRatingFile(table);
    if ('issues' in parsed) {
      const first = parsed.issues[0];
      return {
        ...fail(
          first?.code ?? 'PSC_CATALOG_INVALID',
          `${parsed.issues.length} problem(s), first: ${first?.message ?? 'invalid file'}`,
          [],
          parsed.issues.map((issue) => issue.path),
        ),
        data: { issues: parsed.issues },
      };
    }
    const incoming = parsed.table;
    if (incoming.id === BUNDLED_RATING_TABLE_ID)
      return fail('PSC_CATALOG_CONFLICT', `the id ${BUNDLED_RATING_TABLE_ID} is reserved for the bundled table`, [incoming.id], ['id']);
    const model = getCatalogModel(doc);
    const existing = ratingTableById(doc, incoming.id);
    if (existing !== undefined && canonicalJson(existing) === canonicalJson(incoming))
      return report(doc, `import_rating_table: table ${incoming.id} already present with identical content; nothing changed.`, {
        tableId: incoming.id,
        unchanged: true,
      });
    if (existing !== undefined && !replace)
      return fail('PSC_CATALOG_CONFLICT', `rating table ${incoming.id} already exists with different content`, [incoming.id], ['id']);
    const rival = allRatingTables(doc).find((other) => other.id !== incoming.id && sameBasis(other, incoming));
    if (rival !== undefined)
      return fail(
        'PSC_CATALOG_CONFLICT',
        `rating table ${rival.id} already covers ${incoming.standard} group ${incoming.materialGroup}; one table per standard and group`,
        [rival.id],
        ['standard', 'materialGroup'],
      );
    const next = withCatalogModel(doc, { ...model, ratingTables: { ...model.ratingTables, [incoming.id]: incoming } });
    const unverified = incoming.rows.filter((row) => !row.bar.verified).length;
    return {
      ...changed(
        next,
        `Imported rating table ${incoming.id} (${incoming.standard} group ${incoming.materialGroup}): ${incoming.rows.length} row(s) in ${new Set(incoming.rows.map((row) => row.ratingClass)).size} class(es) (${unverified} unverified).`,
        [],
      ),
      data: {
        tableId: incoming.id,
        standard: incoming.standard,
        materialGroup: incoming.materialGroup,
        rows: incoming.rows.length,
        unverifiedRows: unverified,
        replaced: existing !== undefined,
      },
    };
  },
});

/**
 * @affects none; data = { tableId, text, sha256, bytes, rows }
 * @invariant read-only; the text is the canonical llull-rating-table file (bar, degC, rows by class then temperature, sorted keys); importing it and exporting again gives the identical sha256
 * @failure unknown table id -> PSC_CATALOG_UNKNOWN; export-controlled content without a human signature -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE
 */
export const exportRatingTable = defineCommand({
  name: 'export_rating_table',
  description:
    'Export a rating table (the bundled asme-b16.5-group-1.1 or one imported into the document) as the canonical llull-rating-table JSON: bar and degC, one row per class and temperature with verified and provenance. ' +
    'Returns the text and its sha256; import it again under another id (the bundled id is reserved) with import_rating_table.',
  params: z.object({
    tableId: z
      .string()
      .describe(`Rating table id (list_piping_catalogs ratingTables). Default: the bundled ${BUNDLED_RATING_TABLE_ID}.`)
      .optional(),
    confirmExportControlled,
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { tableId = BUNDLED_RATING_TABLE_ID, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const gated = exportRefusal(doc, 'export_rating_table', 'data', confirmation, ctx);
    if (gated !== null) return gated;
    const found = ratingTableById(doc, tableId);
    if (found === undefined)
      return refuse(
        doc,
        'export_rating_table',
        'PSC_CATALOG_UNKNOWN',
        `no rating table "${tableId}" (available: ${allRatingTables(doc)
          .map((table) => table.id)
          .join(', ')})`,
        [tableId],
        ['tableId'],
      );
    const text = canonicalJson(ratingTableToFile(found));
    const bytes = new TextEncoder().encode(text).length;
    return report(doc, `export_rating_table: ${found.id}: ${found.rows.length} row(s), ${bytes} bytes.`, {
      tableId: found.id,
      text,
      sha256: sha256Hex(text),
      bytes,
      rows: found.rows.length,
    });
  },
});
