/** Catalogue commands (08 MAT M5): import a user catalogue file, list its families, decode a part number. */

import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { FastenerFamily, FastenerSize } from '@aero/fasteners/types';
import { CATALOG_FORMAT, catalogFileSchema, checkFamily, type CatalogIssue } from './catalogFile';
import { fastenerError, refuse, remediationFor } from './codes';
import { fastenerModel, withFasteners } from './fastenerDoc';
import { decodeWithGrammar, type FieldValues } from './partNumber';
import { listedLengthTicks } from './selectCore';
import { ticksToInches, toTicks } from './units';

const FAMILY_KINDS = ['bolt', 'hi_lok_pin', 'solid_rivet', 'blind_rivet', 'lockbolt', 'nut', 'washer', 'collar', 'insert'] as const;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function issueResult(doc: Parameters<typeof refuse>[0], issues: readonly CatalogIssue[]): CommandResult {
  const first = issues[0] as CatalogIssue;
  return {
    document: doc,
    summary: `import_fastener_catalog: ${issues.length} problem(s), first: ${first.message}; no-op (${first.code}).`,
    affected: [],
    data: { issues },
    error: fastenerError(
      first.code,
      [],
      issues.map((issue) => issue.path),
    ),
  };
}

/**
 * @affects fasteners.catalogs (one entry per family in the file)
 * @invariant re-importing identical families changes nothing; a different family under an existing id needs replace:true
 * @failure bad structure / grammar -> FAST_CATALOG_INVALID; bad unit -> MAT_UNIT_*; value without citation -> MAT_PROVENANCE_MISSING; licensed-no-redistribution family -> FAST_LICENCE_EMBED_FORBIDDEN; clash -> FAST_CATALOG_CONFLICT
 */
export const importFastenerCatalog = defineCommand({
  name: 'import_fastener_catalog',
  description:
    'Import a fastener catalogue file into the document (bolts, rivets, Hi-Lok pins, nuts and washers are all families). ' +
    'The file is { format: "llull-fastener-catalog", schemaVersion: 1, families: [...] }; each family has id, kind, standard, a part-number grammar ' +
    '(literal / code table / int fields; an int field named diameterDash selects the size), sizes (dash, nominalDiameter, thread, dims such as headDiameter, ' +
    'height, thickness with options), grip / length rules, licence and provenance. Every dimension needs provenance.citation or sourceId and a parsable ' +
    'length unit. Nothing is bundled: the user supplies the dimensions (licence flags travel with the family; licensed-no-redistribution families are refused: FAST_LICENCE_EMBED_FORBIDDEN). Next: list_fastener_families, select_fastener.',
  params: z.object({
    catalog: z
      .record(z.string(), z.unknown())
      .describe('The catalogue file object: { format: "llull-fastener-catalog", schemaVersion: 1, title?, families: FastenerFamily[] }.'),
    replace: z
      .boolean()
      .describe(
        'Overwrite families whose id already exists with different content. Default false: such a clash is refused (FAST_CATALOG_CONFLICT).',
      )
      .optional(),
  }),
  run: (doc, { catalog, replace = false }): CommandResult => {
    const file = catalogFileSchema.safeParse(catalog);
    if (!file.success) {
      const message = `catalog must be { format: "${CATALOG_FORMAT}", schemaVersion: 1, families: [...] } (${file.error.issues[0]?.path.join('.') ?? 'catalog'})`;
      return issueResult(doc, [{ code: 'FAST_CATALOG_INVALID', path: 'catalog', message }]);
    }
    const families: FastenerFamily[] = [];
    const issues: CatalogIssue[] = [];
    file.data.families.forEach((raw, index) => {
      const checked = checkFamily(raw, `catalog.families.${index}`);
      if ('family' in checked) families.push(checked.family);
      else issues.push(...checked.issues);
    });
    if (issues.length > 0) return issueResult(doc, issues);
    const licensed = families.filter((family) => family.licence === 'licensed-no-redistribution').map((family) => family.id);
    if (licensed.length > 0)
      return refuse(
        doc,
        'import_fastener_catalog',
        'FAST_LICENCE_EMBED_FORBIDDEN',
        `famil${licensed.length === 1 ? 'y' : 'ies'} [${licensed.join(', ')}] licensed-no-redistribution cannot be embedded in a document`,
        licensed,
        licensed.map((id) => `catalog.families.${id}.licence`),
      );
    const existing = fastenerModel(doc).catalogs;
    const clashes = families
      .filter((family) => Object.hasOwn(existing, family.id) && !sameJson(existing[family.id], family))
      .map((family) => family.id);
    if (clashes.length > 0 && !replace)
      return {
        ...refuse(
          doc,
          'import_fastener_catalog',
          'FAST_CATALOG_CONFLICT',
          `famil${clashes.length === 1 ? 'y' : 'ies'} [${clashes.join(', ')}] already exist with different content`,
          clashes,
        ),
        data: { clashes },
      };
    const incoming = families.filter((family) => !Object.hasOwn(existing, family.id) || !sameJson(existing[family.id], family));
    if (incoming.length === 0)
      return report(doc, `import_fastener_catalog: all ${families.length} famil(ies) already present; nothing changed.`, { imported: [] });
    const catalogs = { ...existing, ...Object.fromEntries(incoming.map((family) => [family.id, family])) };
    const ids = incoming.map((family) => family.id);
    return {
      ...changed(
        withFasteners(doc, { catalogs }),
        `Imported ${ids.length} fastener famil(ies): [${ids.join(', ')}] (${incoming.reduce((n, f) => n + f.sizes.length, 0)} sizes).`,
        [],
      ),
      data: { imported: ids, licences: Object.fromEntries(incoming.map((family) => [family.id, family.licence])) },
    };
  },
});

const lengthIn = (value: number, unit: string): number | null => {
  const ticks = toTicks(value, unit, 'in');
  return ticks === null ? null : ticks / 1e6;
};

function sizeSummary(size: FastenerSize): Record<string, unknown> {
  return {
    dash: size.dash,
    diameterIn: lengthIn(size.nominalDiameter.value, size.nominalDiameter.unit),
    ...(size.thread === undefined ? {} : { thread: size.thread }),
    ...(size.threadsPerInch === undefined ? {} : { threadsPerInch: size.threadsPerInch }),
    ...(size.partNumber === undefined ? {} : { partNumber: size.partNumber }),
    dims: Object.keys(size.dims),
  };
}

function familySummary(family: FastenerFamily): Record<string, unknown> {
  return {
    id: family.id,
    kind: family.kind,
    standard: family.standard,
    licence: family.licence,
    gripMode: family.gripMode ?? null,
    gripIncrementIn: family.gripIncrement ? lengthIn(family.gripIncrement.value, family.gripIncrement.unit) : null,
    lengthRule: family.lengthRule?.kind ?? null,
    availableGripDash: family.availableGripDash ?? null,
    partNumberFields: family.partNumber.map((field) => (field.kind === 'literal' ? field.text : `{${field.name}}`)).join(''),
    sizes: family.sizes.map(sizeSummary),
  };
}

/**
 * @affects nothing (query)
 * @failure unknown kind filter -> empty list
 */
export const listFastenerFamilies = defineCommand({
  name: 'list_fastener_families',
  annotations: { readOnly: true },
  description:
    'List the fastener families in the document catalogue: id, kind, standard, licence, grip mode, part-number pattern and every size dash with its diameter in inches. ' +
    'Use it to find the family id and diameterDash that select_fastener and insert_fastener_stack need. Returns data.families; the document is unchanged.',
  params: z.object({
    kind: z
      .enum(FAMILY_KINDS)
      .describe('Optional filter: only families of this kind (bolt, hi_lok_pin, solid_rivet, nut, washer, ...).')
      .optional(),
  }),
  run: (doc, { kind }): CommandResult => {
    const families = Object.values(fastenerModel(doc).catalogs).filter((family) => kind === undefined || family.kind === kind);
    return report(
      doc,
      families.length === 0
        ? 'list_fastener_families: no families in the catalogue (import_fastener_catalog adds them).'
        : `list_fastener_families: ${families.length} famil(ies): ${families.map((family) => `${family.id} (${family.sizes.length} sizes)`).join(', ')}.`,
      { families: families.map(familySummary) },
    );
  },
});

function describeMatch(family: FastenerFamily, partNumber: string, values: FieldValues): Record<string, unknown> {
  const size = family.sizes.find((candidate) => candidate.dash === String(values['diameterDash']));
  const codes = Object.fromEntries(
    family.partNumber.flatMap((field) =>
      field.kind === 'code' && typeof values[field.name] === 'string'
        ? [[field.name, { code: values[field.name], meaning: field.table[String(values[field.name])] }]]
        : [],
    ),
  );
  const quantities: Record<string, number> = {};
  for (const field of family.partNumber) {
    if (field.kind !== 'int') continue;
    const value = values[field.name];
    if (typeof value === 'number' && field.scale !== undefined && field.unit !== undefined) {
      const inches = lengthIn(value * field.scale, field.unit);
      if (inches !== null) quantities[`${field.name.replace(/Dash$/, '')}In`] = inches;
    }
  }
  const gripDash = values['gripDash'];
  const out: Record<string, unknown> = {
    family: family.id,
    kind: family.kind,
    partNumber,
    fields: values,
    codes,
    sizeKnown: size !== undefined,
    ...quantities,
  };
  if (size !== undefined) out['diameterIn'] = lengthIn(size.nominalDiameter.value, size.nominalDiameter.unit);
  if (typeof gripDash === 'number' && family.gripIncrement !== undefined) {
    const step = toTicks(family.gripIncrement.value, family.gripIncrement.unit, 'in') ?? 0;
    if (family.gripMode === 'max_grip_range')
      out['gripRangeIn'] = [ticksToInches((gripDash - 1) * step, 'in'), ticksToInches(gripDash * step, 'in')];
    if (family.lengthRule?.kind === 'grip_plus_thread' && size?.threadLength)
      out['lengthIn'] = listedLengthTicks(gripDash * step, toTicks(size.threadLength.value, size.threadLength.unit, 'in') ?? 0) / 1e6;
  }
  return out;
}

/**
 * @affects nothing (query)
 * @failure no family grammar matches -> data.matches = [], error FAST_PART_NUMBER_UNKNOWN
 */
export const decodePartNumber = defineCommand({
  name: 'decode_part_number',
  annotations: { readOnly: true },
  description:
    'Decode a fastener part number (e.g. "NAS6204-10", "MS20470AD4-5", "HL19-8-10") with the grammars of the catalogue families. ' +
    'Returns data.matches: family, kind, the decoded fields, code meanings, diameterIn and, where the family defines them, gripIn, gripRangeIn (Hi-Lok) and lengthIn (inches). ' +
    'No match -> data.matches = [] and error FAST_PART_NUMBER_UNKNOWN. The document is unchanged.',
  params: z.object({ partNumber: z.string().describe('The part number to decode, e.g. "NAS6204-10".') }),
  run: (doc, { partNumber }): CommandResult => {
    const matches = Object.values(fastenerModel(doc).catalogs).flatMap((family) => {
      const values = decodeWithGrammar(family.partNumber, partNumber);
      return values === null ? [] : [describeMatch(family, partNumber.trim(), values)];
    });
    if (matches.length === 0)
      return {
        ...refuse(doc, 'decode_part_number', 'FAST_PART_NUMBER_UNKNOWN', `no catalogued family matches '${partNumber}'`, [partNumber]),
        data: { matches: [], remediation: remediationFor('FAST_PART_NUMBER_UNKNOWN') },
      };
    return report(doc, `decode_part_number: '${partNumber}' matches ${matches.map((match) => String(match['family'])).join(', ')}.`, {
      matches,
    });
  },
});
