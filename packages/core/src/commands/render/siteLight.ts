/** The key light a document's site context gives a render (plant 09 VIS FR-VIS-18): the computed sun, or sky light only below the horizon. @pure */

import { sunAt } from '../../model/siteContext';
import type { CadDocument } from '../../model/types';
import type { RenderLight } from './camera';

/** `light` for `RenderOptions.light` and the sentence the render summary names it with; null without a (valid) site context. */
export function siteLightOf(doc: Pick<CadDocument, 'siteContext'>): { light: RenderLight; note: string } | null {
  const site = doc.siteContext;
  if (site === undefined) return null;
  const sun = sunAt(site);
  if (sun === null) return null;
  const where = `site sun at ${site.dateTime} (azimuth ${sun.azimuthDeg.toFixed(1)} deg, elevation ${sun.elevationDeg.toFixed(1)} deg)`;
  return sun.up
    ? { light: { direction: sun.direction }, note: `Lit by the ${where}.` }
    : { light: { direction: null }, note: `Sun below the horizon: ${where}; sky light only.` };
}
