/**
 * Catalogue file form (`llull-piping-catalog`, schemaVersion 1; TR-PSC-05, TR-PSC-14): parsing into the stored `PipingCatalog` and the
 * canonical export. Sizes carry their dimensions as flat numeric keys (`outsideDiameter`, `centreToEnd`, `boltCount` …) in the family `unit`
 * (mm or in); the stored form is always millimetres. Structure -> zod; unit, licence and provenance -> a semantic pass with stable codes.
 */

import { z } from '@core/commands/schema';
import { LICENCE_FLAGS } from '@core/model/materialLibrary';
import { canonicalJson } from '@lib/canonicalJson';
import { parseDn, parseNps } from './nominal';
import {
  BEND_RADII,
  COMPONENT_TYPES,
  END_TYPES,
  FACINGS,
  type ComponentFamily,
  type ComponentSize,
  type Dim,
  type NominalSize,
  type PipingCatalog,
  type Provenance,
} from './types';

export const CATALOG_FORMAT = 'llull-piping-catalog';
const MM_PER_INCH = 25.4;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Dimensions that are counts, not lengths. */
const COUNT_DIMS: ReadonlySet<string> = new Set(['boltCount', 'holeCount', 'holes']);
const RESERVED: ReadonlySet<string> = new Set([
  'nps',
  'dn',
  'smallNps',
  'smallDn',
  'schedule',
  'class',
  'pn',
  'facing',
  'verified',
  'verifiedDims',
  'provenance',
  'dimProvenance',
]);

export interface CatalogIssue {
  readonly code: 'PSC_CATALOG_INVALID' | 'PSC_UNIT_INVALID' | 'PSC_PROVENANCE_MISSING' | 'PSC_LICENCE_EMBED_FORBIDDEN';
  readonly path: string;
  readonly message: string;
}

const provenanceSchema = z.object({
  sourceId: z.string().min(1).optional(),
  citation: z.string().min(1).optional(),
  url: z.string().optional(),
  accessed: z.string().optional(),
});
const nominal = z.union([z.number(), z.string()]);
const sizeSchema = z
  .object({
    nps: nominal.optional(),
    dn: nominal.optional(),
    smallNps: nominal.optional(),
    smallDn: nominal.optional(),
    schedule: z.string().min(1).optional(),
    class: z.number().int().positive().optional(),
    pn: z.number().positive().optional(),
    facing: z.enum(FACINGS).optional(),
    verified: z.boolean().optional(),
    verifiedDims: z.array(z.string()).optional(),
    provenance: provenanceSchema.optional(),
    dimProvenance: z.record(z.string(), provenanceSchema).optional(),
  })
  .catchall(z.unknown());
const familySchema = z.object({
  id: z.string().regex(ID_PATTERN),
  type: z.enum(COMPONENT_TYPES),
  standard: z.string().min(1),
  dimensionalStandard: z.enum(['ASME', 'EN', 'ISO', 'company']).optional(),
  radius: z.enum(BEND_RADII).optional(),
  ends: z.array(z.enum(END_TYPES)).optional(),
  unit: z.string().optional(),
  sizes: z.array(sizeSchema).min(1),
});
const fileSchema = z.object({
  format: z.literal(CATALOG_FORMAT),
  schemaVersion: z.literal(1),
  id: z.string().regex(ID_PATTERN),
  version: z.string().min(1).optional(),
  title: z.string().optional(),
  licence: z.enum(LICENCE_FLAGS),
  families: z.array(familySchema).min(1),
});

type FileFamily = z.infer<typeof familySchema>;
type FileSize = z.infer<typeof sizeSchema>;

const hasSource = (provenance: Provenance | undefined): provenance is Provenance =>
  provenance !== undefined && (provenance.citation !== undefined || provenance.sourceId !== undefined);

const provenanceOf = (value: z.infer<typeof provenanceSchema>): Provenance => ({
  ...(value.sourceId === undefined ? {} : { sourceId: value.sourceId }),
  ...(value.citation === undefined ? {} : { citation: value.citation }),
  ...(value.url === undefined ? {} : { url: value.url }),
  ...(value.accessed === undefined ? {} : { accessed: value.accessed }),
});

function nominalOf(
  system: 'nps' | 'dn',
  input: string | number | undefined,
  path: string,
  issues: CatalogIssue[],
): NominalSize | undefined {
  if (input === undefined) return undefined;
  const size = system === 'nps' ? parseNps(input) : parseDn(input);
  if (size === null)
    issues.push({ code: 'PSC_CATALOG_INVALID', path, message: `${path} = ${String(input)} is not a ${system.toUpperCase()} size` });
  return size ?? undefined;
}

function parseSize(size: FileSize, factor: number, path: string, issues: CatalogIssue[]): ComponentSize | null {
  const before = issues.length;
  if ((size.nps === undefined) === (size.dn === undefined))
    issues.push({ code: 'PSC_CATALOG_INVALID', path, message: `${path} needs exactly one of nps / dn` });
  const main = nominalOf('nps', size.nps, `${path}.nps`, issues) ?? nominalOf('dn', size.dn, `${path}.dn`, issues);
  const small = nominalOf('nps', size.smallNps, `${path}.smallNps`, issues) ?? nominalOf('dn', size.smallDn, `${path}.smallDn`, issues);
  const dims: Record<string, Dim> = {};
  const verifiedDims = new Set(size.verifiedDims ?? []);
  for (const [name, raw] of Object.entries(size)) {
    if (RESERVED.has(name)) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      issues.push({ code: 'PSC_CATALOG_INVALID', path: `${path}.${name}`, message: `${path}.${name} must be a finite number >= 0` });
      continue;
    }
    const provenance = size.dimProvenance?.[name] ?? size.provenance;
    const counted = COUNT_DIMS.has(name);
    const resolved = provenance === undefined ? {} : provenanceOf(provenance);
    if (!hasSource(resolved))
      issues.push({
        code: 'PSC_PROVENANCE_MISSING',
        path: `${path}.${name}`,
        message: `${path}.${name} has no provenance.citation or sourceId`,
      });
    dims[name] = {
      value: counted ? raw : Math.round(raw * factor * 1e6) / 1e6,
      unit: counted ? 'count' : 'mm',
      verified: size.verified === true || verifiedDims.has(name),
      provenance: resolved,
    };
  }
  if (Object.keys(dims).length === 0)
    issues.push({ code: 'PSC_CATALOG_INVALID', path, message: `${path} has no dimension (a numeric key such as outsideDiameter)` });
  if (issues.length > before || main === undefined) return null;
  return {
    size: main,
    ...(small === undefined ? {} : { smallSize: small }),
    ...(size.schedule === undefined ? {} : { schedule: size.schedule }),
    ...(size.class === undefined ? {} : { class: size.class }),
    ...(size.pn === undefined ? {} : { pn: size.pn }),
    ...(size.facing === undefined ? {} : { facing: size.facing }),
    dims,
  };
}

function parseFamily(family: FileFamily, index: number, issues: CatalogIssue[]): ComponentFamily | null {
  const path = `families.${index}`;
  const unit = family.unit ?? 'mm';
  if (unit !== 'mm' && unit !== 'in')
    issues.push({
      code: 'PSC_UNIT_INVALID',
      path: `${path}.unit`,
      message: `${path}.unit "${unit}" is not a supported length unit (mm, in)`,
    });
  const factor = unit === 'in' ? MM_PER_INCH : 1;
  const sizes = family.sizes.map((size, k) => parseSize(size, factor, `${path}.sizes.${k}`, issues));
  if (sizes.some((size) => size === null)) return null;
  return {
    id: family.id,
    type: family.type,
    standard: family.standard,
    dimensionalStandard: family.dimensionalStandard ?? (/^(EN|DIN)\b/.test(family.standard) ? 'EN' : 'ASME'),
    ...(family.radius === undefined ? {} : { radius: family.radius }),
    ends: family.ends ?? [],
    sizes: sizes as ComponentSize[],
  };
}

const zodPath = (path: readonly PropertyKey[]): string => path.map(String).join('.');

/** Parses a catalogue file object: the stored catalogue, or every problem found (first = the refusal code). */
export function parseCatalogFile(raw: unknown): { readonly catalog: PipingCatalog } | { readonly issues: readonly CatalogIssue[] } {
  const file = fileSchema.safeParse(raw);
  if (!file.success)
    return {
      issues: file.error.issues.map(
        (issue): CatalogIssue => ({
          code: issue.path.at(-1) === 'unit' ? 'PSC_UNIT_INVALID' : 'PSC_CATALOG_INVALID',
          path: zodPath(issue.path) || 'catalog',
          message: `${zodPath(issue.path) || 'catalog'}: ${issue.message}`,
        }),
      ),
    };
  const issues: CatalogIssue[] = [];
  if (file.data.licence === 'licensed-no-redistribution')
    return {
      issues: [
        {
          code: 'PSC_LICENCE_EMBED_FORBIDDEN',
          path: 'licence',
          message: 'licensed-no-redistribution data cannot be embedded in the document',
        },
      ],
    };
  const families = file.data.families.map((family, index) => parseFamily(family, index, issues));
  if (issues.length > 0 || families.some((family) => family === null)) return { issues };
  return {
    catalog: {
      format: CATALOG_FORMAT,
      schemaVersion: 1,
      id: file.data.id,
      version: file.data.version ?? '1',
      ...(file.data.title === undefined ? {} : { title: file.data.title }),
      licence: file.data.licence,
      families: families as ComponentFamily[],
    },
  };
}

/** Stable order of sizes: value, small value, schedule, class, pn, facing. */
const sizeOrder = (a: ComponentSize, b: ComponentSize): number =>
  a.size.value - b.size.value ||
  (a.smallSize?.value ?? 0) - (b.smallSize?.value ?? 0) ||
  compareText(a.schedule ?? '', b.schedule ?? '') ||
  (a.class ?? 0) - (b.class ?? 0) ||
  (a.pn ?? 0) - (b.pn ?? 0) ||
  compareText(a.facing ?? '', b.facing ?? '');

const nominalKeys = (size: NominalSize | undefined, nps: 'nps' | 'smallNps', dn: 'dn' | 'smallDn'): Record<string, string | number> =>
  size === undefined ? {} : size.system === 'NPS' ? { [nps]: size.key } : { [dn]: size.value };

const sameProvenance = (a: Provenance, b: Provenance): boolean => canonicalJson(a) === canonicalJson(b);

function sizeToFile(size: ComponentSize): Record<string, unknown> {
  const names = Object.keys(size.dims).sort();
  const first = size.dims[names[0] as string] as Dim;
  const verifiedNames = names.filter((name) => size.dims[name]?.verified === true);
  const different = names.filter((name) => !sameProvenance((size.dims[name] as Dim).provenance, first.provenance));
  return {
    ...nominalKeys(size.size, 'nps', 'dn'),
    ...nominalKeys(size.smallSize, 'smallNps', 'smallDn'),
    ...(size.schedule === undefined ? {} : { schedule: size.schedule }),
    ...(size.class === undefined ? {} : { class: size.class }),
    ...(size.pn === undefined ? {} : { pn: size.pn }),
    ...(size.facing === undefined ? {} : { facing: size.facing }),
    ...Object.fromEntries(names.map((name) => [name, (size.dims[name] as Dim).value])),
    ...(verifiedNames.length === names.length ? { verified: true } : verifiedNames.length > 0 ? { verifiedDims: verifiedNames } : {}),
    provenance: first.provenance,
    ...(different.length === 0
      ? {}
      : { dimProvenance: Object.fromEntries(different.map((name) => [name, (size.dims[name] as Dim).provenance])) }),
  };
}

/** The catalogue as a file object in millimetres, families and sizes in stable order (re-importing it gives the same catalogue). */
export function catalogToFile(catalog: PipingCatalog): Record<string, unknown> {
  return {
    format: CATALOG_FORMAT,
    schemaVersion: 1,
    id: catalog.id,
    version: catalog.version,
    ...(catalog.title === undefined ? {} : { title: catalog.title }),
    licence: catalog.licence,
    families: [...catalog.families]
      .sort((a, b) => compareText(a.id, b.id))
      .map((family) => ({
        id: family.id,
        type: family.type,
        standard: family.standard,
        dimensionalStandard: family.dimensionalStandard,
        ...(family.radius === undefined ? {} : { radius: family.radius }),
        ends: family.ends,
        unit: 'mm',
        sizes: [...family.sizes].sort(sizeOrder).map(sizeToFile),
      })),
  };
}
