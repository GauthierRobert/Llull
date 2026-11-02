/** Railing parameters of a platform: the caller's values, else the access-rule defaults of add_railing (each default named in `data.defaults`). */

import { z } from '@core/commands/schema';
import { fromMm } from '@core/model/units';
import type { CadDocument, Vec3 } from '@core/model/types';
import { findProfile } from '../../../steel/profiles';
import { openingParam } from '../railing/addRailing';
import { DEFAULT_POST_SPACING_MM, railingDefaults } from '../railing/railingDefaults';
import { RULESET_NAMES } from '../rules/ruleTable';
import { type AssemblyFailure, failure } from '../assembly/assemblyParts';
import { cumulativeLengths } from '../railing/railingLayout';
import { railingProblem } from '../railing/railingValidate';
import { MAX_POSTS } from './platformGeometry';
import type { RailingSpecFields } from './platformSpec';

const DEFAULT_PROFILE = 'CHS48.3x3.2';

/** The railing fields shared by both platform commands. */
export const railingFieldParams = {
  height: z
    .number()
    .positive()
    .optional()
    .describe(
      'Top of the top rail above the walking surface, DOCUMENT UNITS. Default: the highest top-rail row of the rulesets (1100 mm with both).',
    ),
  kneeRails: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Intermediate rails. Default: the fewest within the ruleset clear-space limit.'),
  toePlate: z
    .number()
    .min(0)
    .optional()
    .describe('Toe-plate height, DOCUMENT UNITS; 0 = none. Default: the highest ruleset minimum (100 mm with both).'),
  postProfile: z.string().optional().describe('Steel catalogue name of the posts (list_steel_profiles). Default CHS48.3x3.2.'),
  railProfile: z.string().optional().describe('Steel catalogue name of the rails. Default CHS48.3x3.2.'),
  postSpacingMax: z.number().positive().optional().describe('Largest distance between posts, DOCUMENT UNITS. Default 1500 mm.'),
  openings: openingParam
    .optional()
    .describe(
      'Gaps in the rails, distances along the railing path from its first point (DOCUMENT UNITS), ascending; gate: true closes a gap with a self-closing gate. Only when the platform has exactly one railing run (edges "all" or consecutive edges, one arc).',
    ),
  rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the unset values. Default both.'),
};

type RailingInput = { [Field in keyof typeof railingFieldParams]?: z.output<(typeof railingFieldParams)[Field]> };

/** Resolved railing fields (document units), or the reason a profile is unknown. Names every defaulted value in `defaulted`. */
export function resolveRailingFields(doc: CadDocument, input: RailingInput, defaulted: string[]): RailingSpecFields | string {
  const railProfile = input.railProfile ?? DEFAULT_PROFILE;
  const postProfile = input.postProfile ?? DEFAULT_PROFILE;
  const rail = findProfile(railProfile);
  if (rail === undefined) return `unknown rail profile '${railProfile}' (list_steel_profiles)`;
  if (findProfile(postProfile) === undefined) return `unknown post profile '${postProfile}' (list_steel_profiles)`;
  const rules = railingDefaults(input.rulesets ?? RULESET_NAMES, rail.h);
  const named = <Value>(value: Value | undefined, fallback: Value, basis: string): Value => {
    if (value === undefined) defaulted.push(`railing ${basis}`);
    return value ?? fallback;
  };
  return {
    height: named(input.height, fromMm(doc, rules.heightMm), rules.basis[0] as string),
    toePlate: named(input.toePlate, fromMm(doc, rules.toePlateMm), rules.basis[1] as string),
    kneeRails: named(input.kneeRails, rules.kneeRails, rules.basis[2] as string),
    postSpacingMax: named(input.postSpacingMax, fromMm(doc, DEFAULT_POST_SPACING_MM), `postSpacingMax ${DEFAULT_POST_SPACING_MM} mm`),
    postProfile,
    railProfile,
    ...(input.openings === undefined
      ? {}
      : { openings: input.openings.map((opening) => ({ from: opening.from, to: opening.to, gate: opening.gate === true })) }),
  };
}

/** The first problem of the railing runs of a platform (openings need one run, post count cap, the add_railing validation), or null. */
export function railingRunsProblem(doc: CadDocument, fields: RailingSpecFields, paths: ReadonlyArray<Vec3[]>): AssemblyFailure | null {
  if ((fields.openings ?? []).length > 0 && paths.length !== 1)
    return failure('STA_RAIL_OPENING', `railing openings need exactly one railing run, the edges give ${paths.length}`, ['railing']);
  for (const path of paths) {
    const lengths = cumulativeLengths(path);
    if ((lengths[lengths.length - 1] as number) / fields.postSpacingMax > MAX_POSTS)
      return failure(
        'STA_INVALID_GEOMETRY',
        `postSpacingMax gives more than ${MAX_POSTS} posts on one railing: check the unit and the spacing`,
        ['railing'],
      );
    const problem = railingProblem(doc, { ...fields, path, openings: fields.openings ?? [], role: 'guardrail' });
    if (problem !== null) return failure(problem.code, `railing: ${problem.message}`, ['railing']);
  }
  return null;
}
