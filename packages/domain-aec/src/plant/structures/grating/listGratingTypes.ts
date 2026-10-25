import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { sectionPerMetre, GRATING_STANDARDS, GRATING_TYPES } from './gratingTypes';

/**
 * @affects none: read-only query, answers in `data.types`
 * @invariant every type carries its bar geometry, mass, section values per metre of width and the `verified` flag
 * @failure none: an empty filter result is an empty list
 */
export const listGratingTypes = defineCommand({
  name: 'list_grating_types',
  description:
    'List the steel bar grating catalogue (NAAMM MBG 531 basis: welded W type, plain bearing bars, 4 in cross bars) used by add_grating and check_grating. ' +
    'Each type has a key such as "19-W-4 1-1/4x3/16" (19/16 in bar pitch, 1-1/4 in deep, 3/16 in thick bars), bar depth / thickness / pitch and cross-bar pitch in millimetres, ' +
    'mass in kg/m2, the bearing-bar section modulus (mm3) and second moment of area (mm4) per metre of width, and `verified`: true only when the mass was checked against ' +
    'two manufacturer tables (19-W-4 1-1/4x3/16 today); other rows have a computed mass and a check against them warns STA_GRATING_TYPE_UNVERIFIED. ' +
    'Read-only; lengths are millimetres whatever the document units.',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    standard: z
      .enum(GRATING_STANDARDS)
      .optional()
      .describe('Catalogue standard. Only "naamm_mbg_531" exists (a metric RAL-GZ / EN catalogue needs two manufacturer tables first).'),
    query: z.string().optional().describe('Case-insensitive text the type key must contain, e.g. "15-W-4" or "1-1/2".'),
  }),
  run: (doc, { standard, query }): CommandResult => {
    const wanted = query?.trim().toLowerCase();
    const types = GRATING_TYPES.filter((type) => standard === undefined || type.standard === standard)
      .filter((type) => wanted === undefined || type.name.toLowerCase().includes(wanted))
      .map((type) => {
        const section = sectionPerMetre(type);
        return { ...type, sectionModulusMm3PerM: section.modulus, secondMomentMm4PerM: section.inertia };
      });
    return report(
      doc,
      `${types.length} grating type(s): ${types.map((type) => `${type.name}${type.verified ? '' : ' (unverified)'}`).join(', ') || 'none'}.`,
      { types },
    );
  },
});
