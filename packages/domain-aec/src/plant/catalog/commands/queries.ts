/** Read-only catalogue queries (plant 01 PSC M1): `list_piping_catalogs`, `lookup_piping_component`. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { bundledRatingTable, IMPORT_ONLY_STANDARDS, BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { inchFraction, resolveCatalogRow, type ResolvedRow } from '../lookup';
import { allCatalogs, findCatalog } from '../store';
import { BEND_RADII, COMPONENT_TYPES, END_TYPES, FACINGS, type ComponentFamily, type PipingCatalog } from '../types';

const nominalParam = z.union([z.number(), z.string()]);

const keys = (values: Iterable<string>): string[] => [...new Set(values)];

function familySummary(family: ComponentFamily): Record<string, unknown> {
  const values = family.sizes.flatMap((size) => Object.values(size.dims));
  return {
    id: family.id,
    type: family.type,
    standard: family.standard,
    dimensionalStandard: family.dimensionalStandard,
    ...(family.radius === undefined ? {} : { radius: family.radius }),
    ends: family.ends,
    sizeKeys: keys(family.sizes.map((size) => `${size.size.system === 'NPS' ? 'NPS' : 'DN'} ${size.size.key}`)),
    ...(family.type === 'pipe' ? { schedules: keys(family.sizes.flatMap((size) => size.schedule ?? [])) } : {}),
    classes: [...new Set(family.sizes.flatMap((size) => size.class ?? []))].sort((a, b) => a - b),
    pns: [...new Set(family.sizes.flatMap((size) => size.pn ?? []))].sort((a, b) => a - b),
    rows: family.sizes.length,
    verifiedValues: values.filter((dim) => dim.verified).length,
    totalValues: values.length,
  };
}

const catalogSummary = (catalog: PipingCatalog, families: readonly ComponentFamily[]): Record<string, unknown> => ({
  id: catalog.id,
  version: catalog.version,
  title: catalog.title ?? null,
  licence: catalog.licence,
  origin: catalog.id === BUNDLED_CATALOG_ID ? 'bundled' : 'document',
  families: families.map(familySummary),
});

/**
 * @affects none; data = { catalogs: [{ id, version, licence, origin, families: [{ id, type, standard, sizeKeys, schedules?, classes, rows, verifiedValues, totalValues }] }], ratingTables, importOnly }
 * @invariant read-only; the bundled catalogue `llull-open-piping` is always listed first
 * @failure unknown catalogId -> PSC_CATALOG_UNKNOWN
 */
export const listPipingCatalogs = defineCommand({
  name: 'list_piping_catalogs',
  description:
    'List the piping component catalogues available: the bundled open catalogue llull-open-piping (ASME B36.10M / B36.19M pipe by NPS and schedule, ' +
    'B16.9 elbows / tees / reducers, B16.5 weld-neck flanges, B16.20 spiral-wound gaskets, B16.10 gate valves, EN 1092-1 PN16 flanges; every value carries its ' +
    'source and a verified flag = two sources agree) and the catalogues imported into this document. Per family: component type, standard, sizes (NPS inch designation or DN), ' +
    'schedules, classes, row count and how many values are verified. Also lists the rating tables and the standards that are import-only (no free source). ' +
    'Filter by catalogId, type or standard. Next: lookup_piping_component for one row, import_piping_catalog to add your own.',
  params: z.object({
    catalogId: z.string().describe('Only this catalogue (id, or id@version). Default: all.').optional(),
    type: z
      .enum(COMPONENT_TYPES)
      .describe('Only families of this component type (pipe, elbow90, flangeWeldNeck, gasketSpiralWound, valveGate …).')
      .optional(),
    standard: z
      .string()
      .describe('Only families whose standard contains this text, case-insensitive (e.g. "B16.9", "EN 1092").')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { catalogId, type, standard }): CommandResult => {
    const catalogs = catalogId === undefined ? allCatalogs(doc) : [findCatalog(doc, catalogId)].flatMap((found) => found ?? []);
    if (catalogs.length === 0)
      return refuse(
        doc,
        'list_piping_catalogs',
        'PSC_CATALOG_UNKNOWN',
        `no catalogue "${catalogId}" (available: ${allCatalogs(doc)
          .map((c) => c.id)
          .join(', ')})`,
        [catalogId ?? ''],
        ['catalogId'],
      );
    const wanted = standard?.toLowerCase();
    const summaries = catalogs.map((catalog) =>
      catalogSummary(
        catalog,
        catalog.families.filter(
          (family) =>
            (type === undefined || family.type === type) && (wanted === undefined || family.standard.toLowerCase().includes(wanted)),
        ),
      ),
    );
    const familyCount = summaries.reduce((count, entry) => count + (entry['families'] as unknown[]).length, 0);
    const rating = bundledRatingTable();
    return report(
      doc,
      `list_piping_catalogs: ${catalogs.length} catalogue(s), ${familyCount} family(ies) [${catalogs.map((c) => c.id).join(', ')}].`,
      {
        catalogs: summaries,
        ratingTables: [
          {
            id: rating.id,
            standard: rating.standard,
            materialGroup: rating.materialGroup,
            classes: [...new Set(rating.rows.map((row) => row.ratingClass))],
          },
        ],
        importOnly: IMPORT_ONLY_STANDARDS,
      },
    );
  },
});

/** Flat answer keys: `<dim>Mm` for lengths, `<dim>` for counts, `<dim>Bar`; bolt diameter also as the inch fraction. */
function flatKeys(row: ResolvedRow): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [name, dim] of Object.entries(row.dims)) {
    if (dim.unit === 'count') flat[name] = dim.value;
    else flat[`${name}${dim.unit === 'mm' ? 'Mm' : 'Bar'}`] = dim.value;
  }
  const bolt = row.dims['boltDiameter'];
  if (bolt !== undefined) flat['boltDiameterIn'] = inchFraction(bolt.value);
  return flat;
}

function lookupData(row: ResolvedRow): Record<string, unknown> {
  return {
    catalogId: row.catalogId,
    catalogVersion: row.catalogVersion,
    familyId: row.familyId,
    type: row.type,
    standard: row.standard,
    dimensionalStandard: row.dimensionalStandard,
    ...(row.radius === undefined ? {} : { radius: row.radius }),
    ends: row.ends,
    size: row.size,
    ...(row.size.system === 'NPS' ? { nps: row.size.key } : { dn: row.size.value }),
    ...(row.smallSize === undefined ? {} : { smallSize: row.smallSize }),
    ...(row.schedule === undefined ? {} : { schedule: row.schedule }),
    ...(row.class === undefined ? {} : { class: row.class }),
    ...(row.pn === undefined ? {} : { pn: row.pn }),
    ...(row.facing === undefined ? {} : { facing: row.facing }),
    ...flatKeys(row),
    dims: row.dims,
    verified: row.verified,
    unverifiedDims: row.unverifiedDims,
    ...(row.verified ? {} : { warnings: [{ code: 'PSC_DATA_UNVERIFIED', dims: row.unverifiedDims }] }),
    alternatives: row.alternatives,
    ...(row.note === undefined ? {} : { note: row.note }),
  };
}

/**
 * @affects none; data = one size row: dims in mm with { value, verified, provenance, derived?, formula? }, flat <dim>Mm keys, verified, unverifiedDims
 * @invariant read-only; exactly one row or a refusal; the same (catalogue, query) always returns the same row; derived values (inside diameter, B16.5 bolt hole, B16.9 LR / SR elbow rule rows) are flagged derived
 * @failure unknown catalogue -> PSC_CATALOG_UNKNOWN; bad size -> PSC_SIZE_UNKNOWN; schedule not defined at the size -> PSC_SCHEDULE_UNKNOWN; no row -> PSC_CATALOG_ROW_MISSING; several rows -> PSC_AMBIGUOUS_COMPONENT
 */
export const lookupPipingComponent = defineCommand({
  name: 'lookup_piping_component',
  description:
    'Look up ONE component size row in a piping catalogue and return its dimensions in millimetres, each with verified (two sources agree) and its source. ' +
    'Give the component type and a nominal size: nps (inch designation "2-1/2" or number 2.5) or dn (integer). Pipe rows are keyed by standard + NPS + schedule: ' +
    'schedule "10" is ASME B36.10M, "10S" is B36.19M, "STD"/"XS"/"XXS" and "40"/"80" also exist; give schedule for a pipe or the answer is ambiguous. ' +
    'Reducers take smallNps; flanges take class (150/300/600 …) and facing, EN flanges take dn and pn. Answers use flat keys such as outsideDiameterMm, wallMm, insideDiameterMm (derived), ' +
    'centreToEndMm, boltCircleMm, boltCount, boltDiameterIn ("5/8"), boltHoleMm (derived), faceToFaceMm, innerRingIdMm, centeringRingOdMm, lengthMm. ' +
    'A missing B16.9 long-radius / short-radius 90 degree elbow size is derived from the standard rule (1.5 x NPS / 1.0 x NPS) and flagged derived. Unverified values are listed with PSC_DATA_UNVERIFIED. ' +
    'Refuses unknown catalogues, sizes and schedules with a code. Next: pipe_section_properties for mass, check_piping_catalog to validate a catalogue.',
  params: z.object({
    catalogId: z.string().describe('Catalogue id, or id@version. Default: the bundled llull-open-piping.').optional(),
    type: z
      .enum(COMPONENT_TYPES)
      .describe('Component type: pipe, elbow90, elbow45, tee, reducerConcentric, flangeWeldNeck, gasketSpiralWound, valveGate …'),
    nps: nominalParam
      .describe('Nominal pipe size, inch designation: "2-1/2", "6" or the number 2.5, 6 (multiples of 1/8). Give nps or dn.')
      .optional(),
    dn: nominalParam
      .describe('Nominal diameter DN, integer (e.g. 100). Converted to NPS through the fixed DN <-> NPS map when the row is NPS-keyed.')
      .optional(),
    smallNps: nominalParam.describe('Branch / small-end NPS of a reducer, reducing tee or olet.').optional(),
    smallDn: nominalParam.describe('Branch / small-end DN of a reducer, reducing tee or olet.').optional(),
    schedule: z.string().describe('Pipe schedule label: "40", "80", "STD", "XS", "XXS", "10S" …').optional(),
    class: z.number().int().positive().describe('ASME pressure class of a flange, gasket or valve: 150, 300, 600 …').optional(),
    pn: z.number().positive().describe('EN pressure nominal PN of a flange: 16, 40 …').optional(),
    facing: z.enum(FACINGS).describe('Flange face: RF, FF, RTJ, TG, MF.').optional(),
    radius: z.enum(BEND_RADII).describe('Elbow bend radius: LR (long, 1.5 x NPS) or SR (short).').optional(),
    standard: z.string().describe('Restrict to families whose standard contains this text (e.g. "B36.19M", "EN 1092-1").').optional(),
    ends: z.enum(END_TYPES).describe('Restrict to families offering this end type (BW, FL, SW …).').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { catalogId = BUNDLED_CATALOG_ID, ...query }): CommandResult => {
    const catalog = findCatalog(doc, catalogId);
    if (catalog === undefined)
      return refuse(
        doc,
        'lookup_piping_component',
        'PSC_CATALOG_UNKNOWN',
        `no catalogue "${catalogId}" (available: ${allCatalogs(doc)
          .map((c) => c.id)
          .join(', ')})`,
        [catalogId],
        ['catalogId'],
      );
    const outcome = resolveCatalogRow(catalog, query);
    if (!outcome.ok) return refuse(doc, 'lookup_piping_component', outcome.code, outcome.message, outcome.ids, ['nps']);
    const row = outcome.row;
    const dimSummary = Object.entries(row.dims)
      .map(([name, dim]) => `${name} ${dim.value}${dim.unit === 'mm' ? ' mm' : ''}${dim.derived === true ? ' (derived)' : ''}`)
      .join(', ');
    const trust = row.verified ? 'verified' : `UNVERIFIED (PSC_DATA_UNVERIFIED): ${row.unverifiedDims.join(', ')}`;
    return report(
      doc,
      `lookup_piping_component: ${row.standard} ${row.type} ${row.size.system} ${row.size.key}${row.schedule === undefined ? '' : ` sch ${row.schedule}`} [${row.familyId}] -> ${dimSummary}; ${trust}.`,
      lookupData(row),
    );
  },
});
