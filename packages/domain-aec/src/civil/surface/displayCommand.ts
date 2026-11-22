/** Civil display setting: the terrain tint of TIN surfaces. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { civilObjectsOf, getCivil } from '../model';
import { commitCivil } from '../evaluate';

/**
 * @affects sets civil.terrainTint and re-derives the TIN mesh of every surface (per-vertex colours `vertexColors`, or the plain layer colour for none)
 * @invariant a document that never calls it (or sets none) is byte-identical to one without the setting; heights are metres above
 *   siteContext.groundElevation (absolute when none), converted from document units
 * @failure setting unchanged -> no-op
 */
export const setCivilDisplay = defineCommand({
  name: 'set_civil_display',
  description:
    'Choose how civil TIN surfaces are coloured. terrainTint "dem2" tints each TIN vertex by its height above the site ground ' +
    '(set_site_context groundElevation, else absolute Z) with the GMT dem2 hypsometric palette (0-4900 m: green, sand, brown, grey, white; ' +
    'heights below ground are black, above 4900 m white, as GMT B/F colours). Renders and the viewport show it. "none" restores the plain ' +
    'surface colour. Off by default; the tint follows later edits of the surface, the site ground or the document units.',
  params: z.object({
    terrainTint: z
      .enum(['none', 'dem2'])
      .describe('"dem2" = hypsometric tint by height above ground; "none" = plain surface colour (default).'),
  }),
  run: (doc, { terrainTint }): CommandResult => {
    const civil = getCivil(doc);
    if ((civil.terrainTint ?? 'none') === terrainTint) return noop(doc, `set_civil_display: terrainTint is already ${terrainTint}.`);
    const model = { ...civil, terrainTint };
    const surfaces = civilObjectsOf(model, 'surface').map((surface) => surface.id);
    return commitCivil(doc, model, surfaces, `Terrain tint ${terrainTint}: re-derived ${surfaces.length} surface(s).`);
  },
});
