/** The key light a document's site context gives a render (plant 09 VIS FR-VIS-18): the computed sun, or sky light only below the horizon. @pure */

import { sunAt } from '../../model/siteContext';
import type { CadDocument } from '../../model/types';
import type { RenderLight } from './camera';
import { GROUND_COLOR, GROUND_DROP, GROUND_MARGIN, SHADOW_MAX_WORK } from './sunShadows';
import { SHADOW_MAP_SIZE } from './shadowMips';
import { PIECE_TEXELS } from './shadowReceivers';
import type { SunShadowReport } from './shadowTypes';

/** `light` for `RenderOptions.light` and the sentence the render summary names it with; null without a (valid) site context. */
export function siteLightOf(doc: Pick<CadDocument, 'siteContext'>): { light: RenderLight; note: string } | null {
  const site = doc.siteContext;
  if (site === undefined) return null;
  const sun = sunAt(site);
  if (sun === null) return null;
  const shadows = { groundElevation: site.groundElevation ?? null };
  const where = `site sun at ${site.dateTime} (azimuth ${sun.azimuthDeg.toFixed(1)} deg, elevation ${sun.elevationDeg.toFixed(1)} deg)`;
  const sky = { sunDirection: sun.direction };
  return sun.up
    ? { light: { direction: sun.direction, sky, shadows }, note: `Lit by the ${where}.` }
    : { light: { direction: null, sky, shadows }, note: `Sun below the horizon: ${where}; sky light only.` };
}

/** The summary sentence for the raster sun shadows and ground plane of `light` ('' without `light.shadows`); `report` = what the shadow pass did (`RenderViewData.sunShadows`). */
export function sunShadowNote(light: RenderLight | undefined, report: SunShadowReport | undefined, raster: boolean): string {
  const shadows = light?.shadows;
  if (shadows === undefined) return '';
  if (!raster) return 'Sun shadows and the site ground plane are drawn in raster mode only.';
  const ground =
    shadows.groundElevation === null
      ? ''
      : ` Ground plane at z=${shadows.groundElevation} (${GROUND_COLOR}, ${GROUND_MARGIN * 100}% of the horizontal extent beyond the model on every side, drawn ${GROUND_DROP * 100}% of the scene radius lower so model faces at that level keep their pixels).`;
  if (light?.direction === null) return `No sun shadows (sun below the horizon).${ground}`;
  if (report?.state === 'skipped')
    return `Sun shadows skipped: the shadow pass would cost ${report.work} texels, over the limit of ${SHADOW_MAX_WORK}; pass sunShadows false to silence this.${ground}`;
  return `Sun shadows: ${SHADOW_MAP_SIZE}x${SHADOW_MAP_SIZE} shadow map fitted to the model; large faces are shaded in pieces of at most ${PIECE_TEXELS} texels, so a shadow edge is placed within about ${PIECE_TEXELS / 2} texels.${ground}`;
}

/** The summary sentence for the raster sky of `light` ('' without `light.sky`). */
export function skyNote(light: RenderLight | undefined, raster: boolean): string {
  if (light?.sky === undefined) return '';
  if (!raster) return 'The sky is drawn in raster mode only.';
  return 'Sky: Preetham daylight model as in three.js Sky.js (turbidity 2, rayleigh 1, mie 0.005, mieDirectionalG 0.8) behind the model, per pixel direction (an orthographic view shows one sky colour); sky: false removes it.';
}
