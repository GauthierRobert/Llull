/**
 * Fastener catalogue validation (08 MAT FR-MAT-11/19, TR-MAT-26): one routine checks a family from a catalogue file and from a saved
 * document, so a family that imports also loads. Structure -> zod; units -> `@lib/quantity`; provenance and grammar -> semantic pass.
 */

import { z } from '@core/commands/schema';
import { LICENCE_FLAGS } from '@core/model/materialLibrary';
import type { FastenerFamily } from '@core/model/fasteners';
import { parseUnit, isUnitFailure } from '@lib/quantity';

export const CATALOG_FORMAT = 'llull-fastener-catalog';

export interface CatalogIssue {
  readonly code: 'FAST_CATALOG_INVALID' | 'MAT_UNIT_INVALID' | 'MAT_UNIT_DIMENSION' | 'MAT_PROVENANCE_MISSING';
  readonly path: string;
  readonly message: string;
}

const provenanceSchema = z.object({
  sourceId: z.string().optional(),
  citation: z.string().optional(),
  locator: z.string().optional(),
  url: z.string().optional(),
  accessed: z.string().optional(),
  note: z.string().optional(),
});
const quantitySchema = z.object({ value: z.number().finite(), unit: z.string() });
const positiveQuantitySchema = z.object({ value: z.number().finite().positive(), unit: z.string() });
const dimensionSchema = z.object({
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  nominal: z.number().finite().optional(),
  options: z.array(z.number().finite()).optional(),
  unit: z.string(),
  provenance: provenanceSchema.optional(),
});
const fieldSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), text: z.string().min(1) }),
  z.object({ kind: z.literal('code'), name: z.string().min(1), table: z.record(z.string(), z.string()) }),
  z.object({
    kind: z.literal('int'),
    name: z.string().min(1),
    scale: z.number().positive().optional(),
    unit: z.string().optional(),
    optional: z.boolean().optional(),
    width: z.number().int().positive().optional(),
  }),
]);
const sizeSchema = z.object({
  dash: z.string().min(1),
  partNumber: z.string().optional(),
  nominalDiameter: quantitySchema,
  thread: z.string().optional(),
  threadsPerInch: z.number().positive().optional(),
  threadLength: quantitySchema.optional(),
  dims: z.record(z.string(), dimensionSchema).default({}),
  holeDiameter: z.object({ min: z.number(), max: z.number(), unit: z.string(), provenance: provenanceSchema.optional() }).optional(),
});
const familySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['bolt', 'hi_lok_pin', 'solid_rivet', 'blind_rivet', 'lockbolt', 'nut', 'washer', 'collar', 'insert']),
  standard: z.object({ body: z.string().min(1), id: z.string().min(1), revision: z.string().optional() }),
  partNumber: z.array(fieldSchema).min(1),
  gripIncrement: positiveQuantitySchema.optional(),
  gripMode: z.enum(['min_grip_ge_stack', 'max_grip_range']).optional(),
  lengthRule: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('grip_plus_thread') }),
      z.object({
        kind: z.literal('stack_plus_k_d'),
        k: z.number().positive(),
        round: z.enum(['up', 'nearest']),
        step: positiveQuantitySchema,
      }),
    ])
    .optional(),
  sizes: z.array(sizeSchema).min(1),
  availableGripDash: z.object({ min: z.number().int(), max: z.number().int() }).optional(),
  licence: z.enum(LICENCE_FLAGS),
  provenance: provenanceSchema.optional(),
});

export const catalogFileSchema = z.object({
  format: z.literal(CATALOG_FORMAT),
  schemaVersion: z.literal(1),
  title: z.string().optional(),
  families: z.array(z.unknown()).min(1),
});

const hasSource = (provenance: { sourceId?: string | undefined; citation?: string | undefined } | undefined): boolean =>
  provenance !== undefined && ((provenance.citation ?? '').trim() !== '' || (provenance.sourceId ?? '').trim() !== '');

type ParsedFamily = z.output<typeof familySchema>;

function unitIssue(unit: string, expect: 'length' | 'mass', path: string): CatalogIssue | null {
  const parsed = parseUnit(unit);
  if (isUnitFailure(parsed)) return { code: parsed.code, path, message: parsed.message };
  const reference = parseUnit(expect === 'length' ? 'mm' : 'g');
  if (isUnitFailure(reference) || parsed.dimension.some((exponent, index) => exponent !== (reference.dimension[index] ?? 0)))
    return { code: 'MAT_UNIT_DIMENSION', path, message: `unit '${unit}' is not a ${expect} unit` };
  return null;
}

function unitIssues(family: ParsedFamily, at: string): CatalogIssue[] {
  const checks: Array<[string, 'length' | 'mass', string]> = [];
  if (family.gripIncrement) checks.push([family.gripIncrement.unit, 'length', `${at}.gripIncrement.unit`]);
  if (family.lengthRule?.kind === 'stack_plus_k_d') checks.push([family.lengthRule.step.unit, 'length', `${at}.lengthRule.step.unit`]);
  family.sizes.forEach((size, index) => {
    const sizeAt = `${at}.sizes.${index}`;
    checks.push([size.nominalDiameter.unit, 'length', `${sizeAt}.nominalDiameter.unit`]);
    if (size.threadLength) checks.push([size.threadLength.unit, 'length', `${sizeAt}.threadLength.unit`]);
    if (size.holeDiameter) checks.push([size.holeDiameter.unit, 'length', `${sizeAt}.holeDiameter.unit`]);
    for (const [name, dimension] of Object.entries(size.dims))
      checks.push([dimension.unit, name === 'mass' ? 'mass' : 'length', `${sizeAt}.dims.${name}.unit`]);
  });
  return checks.flatMap(([unit, expect, path]) => unitIssue(unit, expect, path) ?? []);
}

function provenanceIssues(family: ParsedFamily, at: string): CatalogIssue[] {
  const missing = (path: string): CatalogIssue => ({
    code: 'MAT_PROVENANCE_MISSING',
    path,
    message: `${path} needs provenance.citation or provenance.sourceId (no unsourced catalogue value)`,
  });
  const issues = hasSource(family.provenance) ? [] : [missing(`${at}.provenance`)];
  family.sizes.forEach((size, index) => {
    if (size.holeDiameter && !hasSource(size.holeDiameter.provenance)) issues.push(missing(`${at}.sizes.${index}.holeDiameter.provenance`));
    for (const [name, dimension] of Object.entries(size.dims))
      if (!hasSource(dimension.provenance)) issues.push(missing(`${at}.sizes.${index}.dims.${name}.provenance`));
  });
  return issues;
}

function structureIssues(family: ParsedFamily, at: string): CatalogIssue[] {
  const bad = (path: string, message: string): CatalogIssue => ({ code: 'FAST_CATALOG_INVALID', path, message });
  const issues: CatalogIssue[] = [];
  const names = family.partNumber.flatMap((field) => (field.kind === 'literal' ? [] : [field.name]));
  if (new Set(names).size !== names.length) issues.push(bad(`${at}.partNumber`, 'grammar field names must be unique'));
  if (!family.partNumber.some((field) => field.kind === 'int' && field.name === 'diameterDash'))
    issues.push(bad(`${at}.partNumber`, "grammar needs an int field named 'diameterDash' (it selects the size by `dash`)"));
  family.partNumber.forEach((field, index) => {
    if (field.kind === 'code' && Object.keys(field.table).length === 0)
      issues.push(bad(`${at}.partNumber.${index}.table`, 'code table is empty'));
    if (field.kind === 'int' && (field.scale === undefined) !== (field.unit === undefined))
      issues.push(bad(`${at}.partNumber.${index}`, "int field needs 'scale' and 'unit' together"));
  });
  const dashes = family.sizes.map((size) => size.dash);
  if (new Set(dashes).size !== dashes.length) issues.push(bad(`${at}.sizes`, 'size dashes must be unique'));
  const hasInt = (name: string): boolean => family.partNumber.some((field) => field.kind === 'int' && field.name === name);
  if (family.gripMode !== undefined && (family.gripIncrement === undefined || !hasInt('gripDash')))
    issues.push(bad(`${at}.gripMode`, "gripMode needs gripIncrement and an int grammar field named 'gripDash'"));
  if (family.lengthRule?.kind === 'grip_plus_thread') {
    if (family.gripIncrement === undefined) issues.push(bad(`${at}.lengthRule`, 'grip_plus_thread needs gripIncrement'));
    family.sizes.forEach((size, index) => {
      if (size.threadLength === undefined)
        issues.push(bad(`${at}.sizes.${index}.threadLength`, 'grip_plus_thread needs threadLength on every size'));
    });
  }
  if (family.lengthRule?.kind === 'stack_plus_k_d' && !hasInt('lengthDash'))
    issues.push(bad(`${at}.lengthRule`, "stack_plus_k_d needs an int grammar field named 'lengthDash'"));
  if (family.availableGripDash && family.availableGripDash.min > family.availableGripDash.max)
    issues.push(bad(`${at}.availableGripDash`, 'min must be <= max'));
  family.sizes.forEach((size, index) => {
    for (const [name, dimension] of Object.entries(size.dims))
      if (dimension.min !== undefined && dimension.max !== undefined && dimension.min > dimension.max)
        issues.push(bad(`${at}.sizes.${index}.dims.${name}`, 'min must be <= max'));
  });
  return issues;
}

/**
 * A family from raw data, or every issue found.
 * @failure structure wrong -> FAST_CATALOG_INVALID (zod path); bad unit -> MAT_UNIT_*; missing source -> MAT_PROVENANCE_MISSING
 */
export function checkFamily(raw: unknown, at: string): { family: FastenerFamily } | { issues: CatalogIssue[] } {
  const parsed = familySchema.safeParse(raw);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map(
        (issue): CatalogIssue => ({
          code: 'FAST_CATALOG_INVALID',
          path: [at, ...issue.path].join('.'),
          message: `${[at, ...issue.path].join('.')}: ${issue.message}`,
        }),
      ),
    };
  const issues = [...structureIssues(parsed.data, at), ...unitIssues(parsed.data, at), ...provenanceIssues(parsed.data, at)];
  return issues.length > 0 ? { issues } : { family: parsed.data as unknown as FastenerFamily };
}
