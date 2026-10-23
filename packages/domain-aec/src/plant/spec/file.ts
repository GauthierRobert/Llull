/**
 * Spec file form (`llull-pipe-spec`, schemaVersion 1; TR-PSC-14): parsing into the stored `PipeSpec` and the canonical export. Sizes are written
 * `fromNps` / `toNps` (inch designation or number) or `fromDn` / `toDn`; a component accepts `pressureClass` as an alias of `class`; unknown scalar
 * keys of a component are kept in `extra`; unknown top-level keys are ignored. Structure -> zod; semantics -> issues with paths.
 */

import { z } from '@core/commands/schema';
import { canonicalJson } from '@lib/canonicalJson';
import { BEND_RADII, COMPONENT_TYPES, END_TYPES, FACINGS, type NominalSize } from '../catalog/types';
import { parseSize, sizeOrdinal } from './size';
import { BRANCH_FITTINGS, SPEC_STATUSES, type BranchTable, type ExtraValue, type PipeSpec, type SpecComponent } from './types';

export const SPEC_FORMAT = 'llull-pipe-spec';
export const SPEC_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MM_PER_INCH = 25.4;

export interface SpecIssue {
  readonly code: 'PSC_SPEC_INVALID' | 'PSC_UNIT_INVALID';
  readonly path: string;
  readonly message: string;
}

const nominal = z.union([z.number(), z.string()]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const provenance = z
  .object({
    sourceId: z.string().describe('Source id.').optional(),
    citation: z.string().describe('Citation of the source.').optional(),
    url: z.string().describe('URL of the source.').optional(),
    accessed: z.string().describe('Date the source was accessed.').optional(),
    author: z.string().describe('Author of the spec.').optional(),
  })
  .catchall(z.unknown());

const rangeKeys = {
  fromNps: nominal
    .describe('Smallest NPS of the range, inch designation ("2-1/2") or number (2.5). Give fromNps + toNps or fromDn + toDn.')
    .optional(),
  toNps: nominal.describe('Largest NPS of the range.').optional(),
  fromDn: nominal.describe('Smallest DN of the range (integer).').optional(),
  toDn: nominal.describe('Largest DN of the range (integer).').optional(),
};

const componentSchema = z
  .object({
    id: z.string().regex(SPEC_ID_PATTERN),
    type: z.enum(COMPONENT_TYPES),
    ...rangeKeys,
    branchFromNps: nominal.optional(),
    branchToNps: nominal.optional(),
    branchFromDn: nominal.optional(),
    branchToDn: nominal.optional(),
    catalogRef: z.string().min(1),
    ends: z.enum(END_TYPES).optional(),
    facing: z.enum(FACINGS).optional(),
    class: z.number().int().positive().optional(),
    pressureClass: z.number().int().positive().optional(),
    pn: z.number().positive().optional(),
    radius: z.enum(BEND_RADII).optional(),
    schedule: z.string().min(1).optional(),
    scheduleFromPipe: z.boolean().optional(),
    wallMm: z.number().positive().optional(),
    priority: z.number().int().optional(),
    standard: z.string().min(1).optional(),
    commodityCode: z.string().optional(),
    description: z.string().optional(),
    material: z.string().optional(),
  })
  .catchall(scalar);

const COMPONENT_KEYS: ReadonlySet<string> = new Set(Object.keys(componentSchema.shape));

/** Header members shared by the file and by `create_pipe_spec` (every safety-relevant member is required: AF-31). */
export const headerShape = {
  title: z.string().describe('Human title of the spec.').optional(),
  service: z.string().describe('Service the spec covers, free text ("hydrocarbon process, non-toxic").').optional(),
  dimensionalStandard: z
    .enum(['ASME', 'EN', 'ISO', 'company'])
    .describe(
      'Dimensional standard of the pipe and fittings: ASME (B36.10M / B16.9, NPS) or EN (EN 10220 / EN 10253, DN). No default: name it.',
    ),
  rating: z
    .object({
      system: z.string().min(1).describe('Rating standard: "ASME B16.5" (bundled table for group 1.1), "EN 1092-1" or "company".'),
      class: z.number().int().positive().describe('ASME pressure class (150, 300 …).').optional(),
      pn: z.number().positive().describe('EN pressure nominal (16, 40 …).').optional(),
      materialGroup: z.string().describe('Material group of the rating table, "1.1" for carbon steel.').optional(),
      ratingTableId: z.string().describe('Id of an imported rating table (reserved).').optional(),
    })
    .strict()
    .describe(
      'Pressure rating basis of the spec: { system, class | pn, materialGroup }. check_pipe_spec compares design conditions with it.',
    ),
  materials: z
    .record(z.string(), z.string())
    .describe('Material per product form, e.g. { pipe: "ASTM A106 Gr B", fittings: "ASTM A234 WPB" }.')
    .optional(),
  corrosionAllowance: z
    .object({ value: z.number().min(0).describe('Allowance, >= 0.'), unit: z.string().describe('"mm" or "in".') })
    .strict()
    .describe('Corrosion allowance { value, unit: "mm" | "in" }; stored in mm. Required: there is no default (AF-31).'),
  millTolerance: z.number().min(0).max(0.5).describe('Mill under-tolerance as a fraction of the wall (0.125 = 12.5 %).').optional(),
  designLimits: z
    .object({
      minTemperatureC: z.number().describe('Lowest design temperature in degC.').optional(),
      maxTemperatureC: z.number().describe('Highest design temperature in degC.').optional(),
    })
    .strict()
    .describe('Design temperature limits of the spec in degC.')
    .optional(),
  sizeRange: z
    .object(rangeKeys)
    .strict()
    .describe('Size range of the spec: { fromNps, toNps } (inch designation or number) or { fromDn, toDn }.'),
  catalogs: z
    .array(z.string().min(1))
    .min(1)
    .describe('Catalogue ids searched in order, optionally pinned as id@version (the bundled one is "llull-open-piping").'),
  elbowAngles: z
    .object({
      anglesDeg: z.array(z.number().positive()).min(1).describe('Allowed elbow angles in degrees.'),
      toleranceDeg: z.number().min(0).describe('Angle tolerance in degrees.'),
      trimmedAllowed: z.boolean().describe('Whether a cut-to-angle (trimmed) elbow is allowed.'),
    })
    .strict()
    .describe('Elbow angle rules consumed by routing (02 RTE).')
    .optional(),
  provenance: provenance.describe('Where the spec comes from: { author, citation, accessed }.').optional(),
};

const branchTableSchema = z
  .object({ system: z.enum(['NPS', 'DN']).optional(), cells: z.record(z.string(), z.record(z.string(), z.enum(BRANCH_FITTINGS))) })
  .catchall(z.unknown());

const fileSchema = z
  .object({
    format: z.literal(SPEC_FORMAT),
    schemaVersion: z.literal(1),
    id: z.string().regex(SPEC_ID_PATTERN),
    revision: z.number().int().positive().optional(),
    ...headerShape,
    components: z.array(componentSchema),
    branchTable: branchTableSchema.optional(),
    status: z.enum(SPEC_STATUSES).optional(),
    approval: z.object({ signer: z.string(), signatureId: z.string(), at: z.string() }).strict().optional(),
  })
  .catchall(z.unknown());

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const zodPath = (path: readonly PropertyKey[]): string => path.map(String).join('.');
const invalid = (path: string, message: string): SpecIssue => ({ code: 'PSC_SPEC_INVALID', path, message });

type FileComponent = z.infer<typeof componentSchema>;
type RangeInput = Partial<Record<keyof typeof rangeKeys, string | number | undefined>>;
interface RangeNames {
  readonly fromNps: string;
  readonly toNps: string;
  readonly fromDn: string;
  readonly toDn: string;
}
const RANGE_NAMES: RangeNames = { fromNps: 'fromNps', toNps: 'toNps', fromDn: 'fromDn', toDn: 'toDn' };
const BRANCH_NAMES: RangeNames = { fromNps: 'branchFromNps', toNps: 'branchToNps', fromDn: 'branchFromDn', toDn: 'branchToDn' };

/** A size range in file form -> nominal sizes, pushing a path-tagged issue per problem. */
function parseRange(
  input: RangeInput,
  path: string,
  issues: SpecIssue[],
  names: RangeNames = RANGE_NAMES,
): { readonly from: NominalSize; readonly to: NominalSize } | null {
  const nps = input.fromNps !== undefined || input.toNps !== undefined;
  const dn = input.fromDn !== undefined || input.toDn !== undefined;
  const system = nps ? 'nps' : 'dn';
  const fromRaw = nps ? input.fromNps : input.fromDn;
  const toRaw = nps ? input.toNps : input.toDn;
  const fromName = nps ? names.fromNps : names.fromDn;
  const toName = nps ? names.toNps : names.toDn;
  if (fromRaw === undefined || toRaw === undefined || (nps && dn)) {
    issues.push(invalid(path, `${path} needs ${names.fromNps} + ${names.toNps} or ${names.fromDn} + ${names.toDn}, not a mix`));
    return null;
  }
  const from = parseSize(system, fromRaw);
  const to = parseSize(system, toRaw);
  if (from === null)
    issues.push(invalid(`${path}.${fromName}`, `${path}.${fromName} = ${String(fromRaw)} is not a ${system.toUpperCase()} size`));
  if (to === null) issues.push(invalid(`${path}.${toName}`, `${path}.${toName} = ${String(toRaw)} is not a ${system.toUpperCase()} size`));
  if (from === null || to === null) return null;
  if (sizeOrdinal(from) > sizeOrdinal(to)) {
    issues.push(invalid(path, `${path}: ${fromName} (${from.key}) is larger than ${toName} (${to.key})`));
    return null;
  }
  return { from, to };
}

function parseComponent(raw: FileComponent, path: string, issues: SpecIssue[]): SpecComponent | null {
  const before = issues.length;
  const range = parseRange(raw, path, issues);
  const hasBranch = [raw.branchFromNps, raw.branchToNps, raw.branchFromDn, raw.branchToDn].some((value) => value !== undefined);
  const branch = hasBranch
    ? parseRange(
        { fromNps: raw.branchFromNps, toNps: raw.branchToNps, fromDn: raw.branchFromDn, toDn: raw.branchToDn },
        path,
        issues,
        BRANCH_NAMES,
      )
    : null;
  if (raw.class !== undefined && raw.pressureClass !== undefined && raw.class !== raw.pressureClass)
    issues.push(invalid(`${path}.pressureClass`, `${path}: class and pressureClass differ`));
  if (range === null || issues.length > before) return null;
  const extra = Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => !COMPONENT_KEYS.has(key))
      .map(([key, value]): [string, ExtraValue] => [key, value as ExtraValue]),
  );
  const classValue = raw.class ?? raw.pressureClass;
  return {
    id: raw.id,
    type: raw.type,
    from: range.from,
    to: range.to,
    ...(branch === null ? {} : { branchFrom: branch.from, branchTo: branch.to }),
    catalogRef: raw.catalogRef,
    ...(raw.ends === undefined ? {} : { ends: raw.ends }),
    ...(raw.facing === undefined ? {} : { facing: raw.facing }),
    ...(classValue === undefined ? {} : { class: classValue }),
    ...(raw.pn === undefined ? {} : { pn: raw.pn }),
    ...(raw.radius === undefined ? {} : { radius: raw.radius }),
    ...(raw.schedule === undefined ? {} : { schedule: raw.schedule }),
    ...(raw.scheduleFromPipe === undefined ? {} : { scheduleFromPipe: raw.scheduleFromPipe }),
    ...(raw.wallMm === undefined ? {} : { wallMm: raw.wallMm }),
    ...(raw.priority === undefined ? {} : { priority: raw.priority }),
    ...(raw.standard === undefined ? {} : { standard: raw.standard }),
    ...(raw.commodityCode === undefined ? {} : { commodityCode: raw.commodityCode }),
    ...(raw.description === undefined ? {} : { description: raw.description }),
    ...(raw.material === undefined ? {} : { material: raw.material }),
    ...(Object.keys(extra).length === 0 ? {} : { extra }),
  };
}

function parseBranchTable(raw: z.infer<typeof branchTableSchema>, system: NominalSize['system'], issues: SpecIssue[]): BranchTable | null {
  const before = issues.length;
  if (raw.system !== undefined && raw.system !== system)
    issues.push(invalid('branchTable.system', `branchTable.system ${raw.system} differs from the size range system ${system}`));
  const kind = system === 'NPS' ? 'nps' : 'dn';
  const cells: Record<string, Record<string, (typeof BRANCH_FITTINGS)[number]>> = {};
  for (const [header, row] of Object.entries(raw.cells)) {
    const headerSize = parseSize(kind, header);
    if (headerSize === null) issues.push(invalid(`branchTable.cells.${header}`, `branchTable.cells.${header} is not a ${system} size`));
    for (const [branch, fitting] of Object.entries(row)) {
      const branchSize = parseSize(kind, branch);
      if (branchSize === null)
        issues.push(invalid(`branchTable.cells.${header}.${branch}`, `branchTable.cells.${header}.${branch} is not a ${system} size`));
      if (headerSize !== null && branchSize !== null) cells[headerSize.key] = { ...cells[headerSize.key], [branchSize.key]: fitting };
    }
  }
  return issues.length > before ? null : { system, cells };
}

/** Parses a spec file object: the stored spec (status as written, default draft), or every problem found. */
export function parseSpecFile(raw: unknown): { readonly spec: PipeSpec } | { readonly issues: readonly SpecIssue[] } {
  const file = fileSchema.safeParse(raw);
  if (!file.success)
    return {
      issues: file.error.issues.map((issue) =>
        invalid(zodPath(issue.path) || 'spec', `${zodPath(issue.path) || 'spec'}: ${issue.message}`),
      ),
    };
  const data = file.data;
  const issues: SpecIssue[] = [];
  const unit = data.corrosionAllowance.unit;
  if (unit !== 'mm' && unit !== 'in')
    issues.push({
      code: 'PSC_UNIT_INVALID',
      path: 'corrosionAllowance.unit',
      message: `corrosionAllowance.unit "${unit}" is not mm or in`,
    });
  const range = parseRange(data.sizeRange, 'sizeRange', issues);
  const components = data.components.map((component, index) => parseComponent(component, `components.${index}`, issues));
  const seen = new Set<string>();
  data.components.forEach((component, index) => {
    if (seen.has(component.id)) issues.push(invalid(`components.${index}.id`, `component id ${component.id} is used twice`));
    seen.add(component.id);
  });
  const table =
    data.branchTable === undefined || range === null ? undefined : parseBranchTable(data.branchTable, range.from.system, issues);
  if (issues.length > 0 || range === null || components.some((component) => component === null)) return { issues };
  const author = data.provenance;
  const allowance = round6(unit === 'in' ? data.corrosionAllowance.value * MM_PER_INCH : data.corrosionAllowance.value);
  return {
    spec: {
      format: SPEC_FORMAT,
      schemaVersion: 1,
      id: data.id,
      revision: data.revision ?? 1,
      ...(data.title === undefined ? {} : { title: data.title }),
      ...(data.service === undefined ? {} : { service: data.service }),
      dimensionalStandard: data.dimensionalStandard,
      rating: data.rating,
      ...(data.materials === undefined ? {} : { materials: data.materials }),
      corrosionAllowance: { value: allowance, unit: 'mm' },
      ...(data.millTolerance === undefined ? {} : { millTolerance: data.millTolerance }),
      ...(data.designLimits === undefined ? {} : { designLimits: data.designLimits }),
      sizeRange: range,
      catalogs: data.catalogs,
      components: components as SpecComponent[],
      ...(table === undefined || table === null ? {} : { branchTable: table }),
      ...(data.elbowAngles === undefined ? {} : { elbowAngles: data.elbowAngles }),
      status: data.status ?? 'draft',
      ...(data.approval === undefined ? {} : { approval: data.approval }),
      ...(author === undefined
        ? {}
        : { provenance: Object.fromEntries(Object.entries(author).filter(([, value]) => typeof value === 'string')) }),
    },
  };
}

const sizeKeys = (from: NominalSize, to: NominalSize, names: RangeNames): Record<string, string | number> =>
  from.system === 'NPS' ? { [names.fromNps]: from.key, [names.toNps]: to.key } : { [names.fromDn]: from.value, [names.toDn]: to.value };

function componentToFile(component: SpecComponent): Record<string, unknown> {
  return {
    id: component.id,
    type: component.type,
    ...sizeKeys(component.from, component.to, RANGE_NAMES),
    ...(component.branchFrom === undefined || component.branchTo === undefined
      ? {}
      : sizeKeys(component.branchFrom, component.branchTo, BRANCH_NAMES)),
    catalogRef: component.catalogRef,
    ...(component.ends === undefined ? {} : { ends: component.ends }),
    ...(component.facing === undefined ? {} : { facing: component.facing }),
    ...(component.class === undefined ? {} : { class: component.class }),
    ...(component.pn === undefined ? {} : { pn: component.pn }),
    ...(component.radius === undefined ? {} : { radius: component.radius }),
    ...(component.schedule === undefined ? {} : { schedule: component.schedule }),
    ...(component.scheduleFromPipe === undefined ? {} : { scheduleFromPipe: component.scheduleFromPipe }),
    ...(component.wallMm === undefined ? {} : { wallMm: component.wallMm }),
    ...(component.priority === undefined ? {} : { priority: component.priority }),
    ...(component.standard === undefined ? {} : { standard: component.standard }),
    ...(component.commodityCode === undefined ? {} : { commodityCode: component.commodityCode }),
    ...(component.description === undefined ? {} : { description: component.description }),
    ...(component.material === undefined ? {} : { material: component.material }),
    ...component.extra,
  };
}

/** The spec as a file object in millimetres (re-importing it gives the same spec). */
export function specToFile(spec: PipeSpec): Record<string, unknown> {
  return {
    format: SPEC_FORMAT,
    schemaVersion: 1,
    id: spec.id,
    revision: spec.revision,
    ...(spec.title === undefined ? {} : { title: spec.title }),
    ...(spec.service === undefined ? {} : { service: spec.service }),
    dimensionalStandard: spec.dimensionalStandard,
    rating: spec.rating,
    ...(spec.materials === undefined ? {} : { materials: spec.materials }),
    corrosionAllowance: spec.corrosionAllowance,
    ...(spec.millTolerance === undefined ? {} : { millTolerance: spec.millTolerance }),
    ...(spec.designLimits === undefined ? {} : { designLimits: spec.designLimits }),
    sizeRange: sizeKeys(spec.sizeRange.from, spec.sizeRange.to, RANGE_NAMES),
    catalogs: spec.catalogs,
    components: spec.components.map(componentToFile),
    ...(spec.branchTable === undefined ? {} : { branchTable: spec.branchTable }),
    ...(spec.elbowAngles === undefined ? {} : { elbowAngles: spec.elbowAngles }),
    status: spec.status,
    ...(spec.approval === undefined ? {} : { approval: spec.approval }),
    ...(spec.provenance === undefined ? {} : { provenance: spec.provenance }),
  };
}

/** Canonical JSON text of a spec (sorted keys at every depth): the text export hashes and import reproduces. */
export const canonicalSpecText = (spec: PipeSpec): string => canonicalJson(specToFile(spec));
