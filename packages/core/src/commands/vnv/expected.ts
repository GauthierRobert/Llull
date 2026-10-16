/** `expected_results.json` schema (docs/physics/README.md §6.3) shared by every physics pack, plus the 05 FEA legacy adapter. */

import { z } from '../schema';

export type JsonValue = number | string | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(jsonValue), z.record(z.string(), jsonValue)]),
);

const bound = z.number().nonnegative().nullable().optional();

export const expectedCaseSchema = z.looseObject({
  id: z.string().min(1),
  quantity: z.string().default(''),
  value: jsonValue,
  unit: z.string(),
  tolerance: z.looseObject({ rel: bound, abs: bound, exact: z.boolean().optional() }).default({}),
  source: z.string().default(''),
  grade: z.string(),
  proves: z.array(z.string()).default([]),
  expected: jsonValue.optional(),
  harness: z
    .object({
      plan: z.string().optional(),
      calls: z.array(z.string()),
      pointer: z.string(),
      kernel: z.enum(['occt', 'manifold']).optional(),
    })
    .optional(),
});

export type ExpectedCase = z.output<typeof expectedCaseSchema>;

export const expectedResultsFileSchema = z.looseObject({
  pack: z.string().min(1),
  generatedBy: z.string(),
  cases: z.array(expectedCaseSchema),
});

export type ExpectedResultsFile = z.output<typeof expectedResultsFileSchema>;

export type Grade = 'A' | 'B' | 'C' | 'TBD';

/** Leading grade token: `"A (given the table)"` -> `A`; anything else -> null. */
export function normaliseGrade(grade: string): Grade | null {
  const match = /^\s*(TBD|A|B|C)\b/.exec(grade);
  return match === null ? null : (match[1] as Grade);
}

const legacyCaseSchema = z.looseObject({
  id: z.string().min(1),
  quantity: z.string().optional(),
  value: jsonValue,
  unit: z.string(),
  tolerance_rel: z.number().nullable().optional(),
  tolerance_abs: z.number().nullable().optional(),
  sources: z.array(z.string()).optional(),
  derivation: z.unknown().optional(),
});

/**
 * 05 FEA `fea_analytic_expected.json` case (`tolerance_rel` / `tolerance_abs`, `sources[]`) -> §6.3 case: grade A when derived by the
 * generator (`derivation` present), else B; `proves` from the caller's hand-maintained map.
 * @failure not a legacy case -> null
 */
export function adaptLegacyCase(raw: unknown, proves: readonly string[] = []): ExpectedCase | null {
  const parsed = legacyCaseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const legacy = parsed.data;
  const tolerance: { rel?: number | null; abs?: number | null } = {};
  if (legacy.tolerance_rel !== undefined) tolerance.rel = legacy.tolerance_rel;
  if (legacy.tolerance_abs !== undefined) tolerance.abs = legacy.tolerance_abs;
  return {
    ...legacy,
    quantity: legacy.quantity ?? legacy.id,
    tolerance,
    source: (legacy.sources ?? []).join('; '),
    grade: legacy.derivation !== undefined ? 'A' : 'B',
    proves: [...proves],
  };
}
