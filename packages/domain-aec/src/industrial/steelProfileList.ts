/**
 * @layer domain-aec
 */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, tolerant, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { STEEL_PROFILES } from '../steel/profiles';

/**
 * @command list_steel_profiles
 * @pure read-only
 * @affects none; data = { profiles: SteelProfile[] }
 */
export const listSteelProfiles = defineCommand({
  name: 'list_steel_profiles',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only steel section catalogue: IPE, HEA, HEB, UPN, cold-formed C purlins, SHS, RHS, CHS and ' +
    'equal angles L, with depth h, width b, web / flange thickness (mm), mass (kg/m), area (mm²) and paint ' +
    'perimeter (mm). Optionally filter by family.',
  params: z.object({
    // tolerant: lower-case / padded family names are normalised in run.
    family: tolerant(
      z
        .enum(['IPE', 'HEA', 'HEB', 'UPN', 'C', 'SHS', 'RHS', 'CHS', 'L'])
        .optional()
        .describe('Only this family.'),
    ),
  }),
  run: (doc, { family }): CommandResult => {
    const raw: unknown = family;
    if (raw !== undefined && typeof raw !== 'string') {
      return noop(doc, 'list_steel_profiles: family must be a string such as "HEA".');
    }
    const wanted = raw?.trim().toUpperCase();
    const families: string[] = [...new Set(STEEL_PROFILES.map((profile) => profile.family))];
    if (wanted !== undefined && !families.includes(wanted)) {
      return noop(
        doc,
        `list_steel_profiles: unknown family '${raw?.trim()}' (valid families: ${families.join(', ')}).`,
      );
    }
    const profiles = STEEL_PROFILES.filter(
      (profile) => wanted === undefined || profile.family === wanted,
    );
    return {
      document: doc,
      summary: `${profiles.length} steel profile(s): ${profiles.map((profile) => profile.name).join(', ')}.`,
      affected: [],
      data: { profiles },
    };
  },
});
