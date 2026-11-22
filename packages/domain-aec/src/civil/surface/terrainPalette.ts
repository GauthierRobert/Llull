/**
 * Hypsometric terrain tint of civil TIN surfaces. Palette `dem2` is GMT's `share/cpt/gmt/dem2.cpt` (Paul Wessel, GMT Team, LGPL-3.0-or-later;
 * validation/data/gmt_cpt/NOTICE.md, sources.md S31): 7 linear RGB slices over 0-4900 m, scaled from the file's normalised z by its RANGE.
 * The constant is checked against a parse of the vendored file by tests/unit/civil/terrainPalette.test.ts.
 */

import { appendAll } from '@lib/appendAll';
import { cptColour, type Cpt } from '@lib/cpt';
import type { TerrainTint } from '@aec/civil/types';

type Named = Exclude<TerrainTint, 'none'>;

// prettier-ignore
export const DEM2: Cpt = {
  slices: [
    { z0: 0, rgb0: [0, 97, 71], z1: 50, rgb1: [16, 122, 47] },
    { z0: 50, rgb0: [16, 122, 47], z1: 500.000000002, rgb1: [232, 215, 125] },
    { z0: 500.000000002, rgb0: [232, 215, 125], z1: 1200.000000002, rgb1: [161, 67, 0] },
    { z0: 1200.000000002, rgb0: [161, 67, 0], z1: 1699.999999999, rgb1: [100, 50, 25] },
    { z0: 1699.999999999, rgb0: [100, 50, 25], z1: 2800.000000002, rgb1: [110, 109, 108] },
    { z0: 2800.000000002, rgb0: [110, 109, 108], z1: 3999.999999999, rgb1: [255, 254, 253] },
    { z0: 3999.999999999, rgb0: [255, 254, 253], z1: 4900, rgb1: [255, 254, 253] },
  ],
  background: [0, 0, 0],
  foreground: [255, 255, 255],
  nan: [128, 128, 128],
};

export const TERRAIN_PALETTES: Readonly<Record<Named, Cpt>> = { dem2: DEM2 };

/**
 * Per-vertex sRGB bytes (r, g, b per vertex of `positions`) of the elevation of each vertex above `groundMetres` (metres per document unit
 * `metresPerUnit`). Heights outside the palette take its B / F colours, as GMT does.
 * @pure
 */
export function terrainVertexColours(
  positions: ReadonlyArray<number>,
  palette: Named,
  groundElevation: number,
  metresPerUnit: number,
): number[] {
  const cpt = TERRAIN_PALETTES[palette];
  const colours: number[] = [];
  for (let i = 2; i < positions.length; i += 3)
    appendAll(colours, cptColour(cpt, ((positions[i] as number) - groundElevation) * metresPerUnit));
  return colours;
}
