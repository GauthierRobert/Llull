/** Catalogue file commands (plant 01 PSC M1): `import_piping_catalog` (mutating) and `export_piping_catalog` (read-only). */

import { confirmExportControlled, defineCommand, z } from '@core/commands/schema';
import { exportRefusal, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { csvLines, type CsvCell } from '@lib/csv';
import { guardCell, guardRows } from '../csvGuard';
import { sha256Hex } from '@lib/sha256';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { catalogToFile, parseCatalogFile } from '../file';
import { CATALOG_FIXED_COLUMNS } from '../sheetImport';
import { storeCatalog } from './storeCatalog';
import { allCatalogs, findCatalog } from '../store';
import type { PipingCatalog } from '../types';

/**
 * @affects plant.catalog.catalogs[catalog.id] (document slice; the bundled catalogue is never written)
 * @invariant re-importing identical content changes nothing; different content under an existing id needs replace:true; every stored value is millimetres / counts with provenance
 * @failure bad structure / non-numeric or negative value -> PSC_CATALOG_INVALID (paths); unit not mm / in -> PSC_UNIT_INVALID; value without citation or source id -> PSC_PROVENANCE_MISSING; licensed-no-redistribution -> PSC_LICENCE_EMBED_FORBIDDEN; id clash -> PSC_CATALOG_CONFLICT
 */
export const importPipingCatalog = defineCommand({
  name: 'import_piping_catalog',
  description:
    'Import a piping component catalogue file into the document. The file is { format: "llull-piping-catalog", schemaVersion: 1, id, version?, title?, licence, families: [...] }; ' +
    'a family is { id, type (pipe, elbow90, flangeWeldNeck …), standard ("ASME B16.9"), dimensionalStandard? (ASME | EN | ISO | company), radius? (LR | SR), ends?, unit? (mm | in, default mm), sizes: [...] }; ' +
    'a size is { nps or dn, smallNps? / smallDn?, schedule?, class?, pn?, facing?, <dimension>: number … (outsideDiameter, wall, centreToEnd, boltCircle, boltCount, …), ' +
    'provenance: { citation or sourceId }, dimProvenance?, verified? | verifiedDims? }. Every dimension needs provenance.citation or sourceId, and a value is unverified unless the file says verified (AF-32). ' +
    'Imported values are stored in millimetres. Licence licensed-no-redistribution is refused (PSC_LICENCE_EMBED_FORBIDDEN). Nothing is bundled for ASME B16.11, olets, EN 10253 or B16.47: import them here. ' +
    'The id llull-open-piping is reserved. Next: check_piping_catalog to validate the dimensions against the standards, lookup_piping_component to read rows.',
  params: z.object({
    catalog: z
      .record(z.string(), z.unknown())
      .describe(
        'The catalogue file object: { format: "llull-piping-catalog", schemaVersion: 1, id, licence, families: ComponentFamily[] }.',
      ),
    replace: z
      .boolean()
      .describe(
        'Overwrite a catalogue with the same id but different content. Default false: such a clash is refused (PSC_CATALOG_CONFLICT).',
      )
      .optional(),
  }),
  run: (doc, { catalog, replace = false }): CommandResult => {
    const parsed = parseCatalogFile(catalog);
    if ('issues' in parsed) {
      const first = parsed.issues[0];
      return {
        ...refuse(
          doc,
          'import_piping_catalog',
          first?.code ?? 'PSC_CATALOG_INVALID',
          `${parsed.issues.length} problem(s), first: ${first?.message ?? 'invalid file'}`,
          [],
          parsed.issues.map((issue) => issue.path),
        ),
        data: { issues: parsed.issues },
      };
    }
    return storeCatalog(doc, 'import_piping_catalog', parsed.catalog, replace);
  },
});

const FIXED_NAMES: ReadonlySet<string> = new Set([...CATALOG_FIXED_COLUMNS, 'verified']);

/** One row per size: the fixed columns (family attributes repeated, the provenance of the row = that of its first dimension), then a column per dimension. */
function catalogCsv(catalog: PipingCatalog): string {
  const names = [...new Set(catalog.families.flatMap((family) => family.sizes.flatMap((size) => Object.keys(size.dims))))].sort();
  const header = (name: string): string => (FIXED_NAMES.has(name) ? `dim.${name}` : name);
  const rows = catalog.families.flatMap((family) =>
    family.sizes.map((size): CsvCell[] => {
      const first = Object.keys(size.dims)
        .sort()
        .map((name) => size.dims[name])[0];
      const source = first?.provenance;
      return [
        family.id,
        family.type,
        family.standard,
        `${size.size.system} ${size.size.key}`,
        size.smallSize === undefined ? null : `${size.smallSize.system} ${size.smallSize.key}`,
        size.schedule ?? null,
        size.class ?? null,
        size.pn ?? null,
        size.facing ?? null,
        family.dimensionalStandard,
        family.radius ?? null,
        family.ends.join(' ') || null,
        source?.sourceId ?? null,
        source?.citation ?? null,
        source?.url ?? null,
        source?.accessed ?? null,
        ...names.map((name) => size.dims[name]?.value ?? null),
        Object.values(size.dims).every((dim) => dim.verified),
      ];
    }),
  );
  return csvLines(
    [...CATALOG_FIXED_COLUMNS, ...names.map(header), 'verified'].map((name) => guardCell(name) as string),
    guardRows(rows),
  );
}

/**
 * @affects none; data = { catalogId, format, text, sha256, bytes, families, rows }
 * @invariant read-only; json is the canonical file (sorted keys, millimetres, stable row order) and re-importing it reproduces the catalogue; sha256 is of the text
 * @failure unknown catalogue or family -> PSC_CATALOG_UNKNOWN; licensed-no-redistribution library -> PSC_LICENCE_EMBED_FORBIDDEN; export-controlled content in the document without a human signature -> MAT_EXPORT_CONTROLLED / MAT_HUMAN_GATE
 */
export const exportPipingCatalog = defineCommand({
  name: 'export_piping_catalog',
  description:
    'Export a piping catalogue (bundled llull-open-piping or one imported into the document) as canonical JSON (format llull-piping-catalog, sorted keys, millimetres, stable row order) ' +
    'or CSV (one row per size, one column per dimension). Returns the text and its sha256: exporting, importing under the same id and exporting again gives the identical hash. ' +
    'Pass familyId to export one family only (the bundled catalogue is large). The JSON re-imports with import_piping_catalog (use another id for the bundled one).',
  params: z.object({
    catalogId: z.string().describe('Catalogue id, or id@version. Default: the bundled llull-open-piping.').optional(),
    format: z.enum(['json', 'csv']).describe('json = canonical llull-piping-catalog file; csv = one row per size.').optional(),
    familyId: z.string().describe('Export only this family (id as listed by list_piping_catalogs).').optional(),
    confirmExportControlled,
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { catalogId = BUNDLED_CATALOG_ID, format = 'json', familyId, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const gated = exportRefusal(doc, 'export_piping_catalog', 'data', confirmation, ctx);
    if (gated !== null) return gated;
    const found = findCatalog(doc, catalogId);
    if (found === undefined)
      return refuse(
        doc,
        'export_piping_catalog',
        'PSC_CATALOG_UNKNOWN',
        `no catalogue "${catalogId}" (available: ${allCatalogs(doc)
          .map((c) => c.id)
          .join(', ')})`,
        [catalogId],
        ['catalogId'],
      );
    if (found.licence === 'licensed-no-redistribution')
      return refuse(
        doc,
        'export_piping_catalog',
        'PSC_LICENCE_EMBED_FORBIDDEN',
        `catalogue ${found.id} is a licensed private library: its values are not exported`,
        [found.id],
        ['catalogId'],
      );
    const families = familyId === undefined ? found.families : found.families.filter((family) => family.id === familyId);
    if (families.length === 0)
      return refuse(
        doc,
        'export_piping_catalog',
        'PSC_CATALOG_UNKNOWN',
        `catalogue ${found.id} has no family "${familyId}"`,
        [found.id],
        ['familyId'],
      );
    const catalog: PipingCatalog = { ...found, families };
    const text = format === 'csv' ? catalogCsv(catalog) : canonicalJson(catalogToFile(catalog));
    const rows = families.reduce((count, family) => count + family.sizes.length, 0);
    return report(
      doc,
      `export_piping_catalog: ${found.id}@${found.version} as ${format}: ${families.length} family(ies), ${rows} row(s), ${text.length} bytes.`,
      {
        catalogId: found.id,
        format,
        text,
        sha256: sha256Hex(text),
        bytes: text.length,
        families: families.map((family) => family.id),
        rows,
      },
    );
  },
});
