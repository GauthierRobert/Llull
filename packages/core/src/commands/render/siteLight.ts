/** The key light a document's site context gives a render (plant 09 VIS FR-VIS-18): the computed sun, or sky light only below the horizon. @pure */

import { sunAt } from '../../model/siteContext';
import type { CadDocument } from '../../model/types';
import type { RenderLight } from './camera';
import { GROUND_COLOR, GROUND_MARGIN, SHADOW_MAP_SIZE, SHADOW_MAX_POLYGONS } from './sunShadows';

/** `light` for `RenderOptions.light` and the sentence the render summary names it with; null without a (valid) site context. */
export function siteLightOf(doc: Pick<CadDocument, 'siteContext'>): { light: RenderLight; note: string } | null {
  const site = doc.siteContext;
  if (site === undefined) return null;
  const sun = sunAt(site);
  if (sun === null) return null;
  const shadows = { groundElevation: site.groundElevation ?? null };
  const where = `site sun at ${site.dateTime} (azimuth ${sun.azimuthDeg.toFixed(1)} deg, elevation ${sun.elevationDeg.toFixed(1)} deg)`;
  return sun.up
    ? { light: { direction: sun.direction, shadows }, note: `Lit by the ${where}.` }
    : { light: { direction: null, shadows }, note: `Sun below the horizon: ${where}; sky light only.` };
}

/** The summary sentence for the raster sun shadows and ground plane of `light` (''  without `light.shadows`); `polygonCount` = filled polygons drawn. */
export function sunShadowNote(light: RenderLight | undefined, polygonCount: number, raster: boolean): string {
  const shadows = light?.shadows;
  if (shadows === undefined) return '';
  if (!raster) return 'Sun shadows and the site ground plane are drawn in raster mode only.';
  const ground =
    shadows.groundElevation === null
      ? ''
      : ` Ground plane at z=${shadows.groundElevation} (${GROUND_COLOR}, ${GROUND_MARGIN * 100}% of the horizontal extent beyond the model on every side).`;
  if (light?.direction === null) return `No sun shadows (sun below the horizon).${ground}`;
  if (polygonCount > SHADOW_MAX_POLYGONS)
    return `Sun shadows skipped: ${polygonCount} polygons exceed the limit of ${SHADOW_MAX_POLYGONS}; pass sunShadows false to silence this.${ground}`;
  return `Sun shadows: ${SHADOW_MAP_SIZE}x${SHADOW_MAP_SIZE} shadow map fitted to the model (error of about one texel at the shadow edges).${ground}`;
}
