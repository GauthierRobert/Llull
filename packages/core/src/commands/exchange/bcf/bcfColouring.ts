/**
 * Viewpoint colouring of export_bcf (plant 09 VIS §6): the colour profile of a viewpoint (its own, else the active one) and the material-class colours, applied to the scene the
 * snapshot is drawn from and written as the viewpoint's `Coloring` (one Color per colour, the entities it paints as components). Above `MAX_COLOURED_COMPONENTS` painted
 * components of one viewpoint (the BCF optimisation rule, R7) no Coloring is written: the profile goes out as legend labels of the topic (`VIS_BCF_COLOURING_LARGE`).
 * @invariant pure; the document is never modified; a viewpoint naming a profile that no longer exists is refused with the render_view code
 */

import type { CadDocument } from '../../../model/types';
import type { ExecutionContext } from '../../types';
import { FRAME_BACKGROUND, hexRgb } from '../../render/frames';
import { applyReviewStyle, resolveReviewStyle } from '../../render/reviewStyle';
import type { ViewpointColouring } from './bcfXml';

/** Above this many painted components in one viewpoint the profile is written as a legend label instead of per-component colouring ([R7]). */
export const MAX_COLOURED_COMPONENTS = 1000;

export interface ViewpointStyle {
  /** The document the snapshot is drawn from (colours applied, viewpoint visibility honoured). */
  readonly scene: CadDocument;
  /** Coloring groups; empty when nothing is painted or the count is over the limit. */
  readonly colouring: readonly ViewpointColouring[];
  readonly coloured: number;
  readonly large: boolean;
  /** Legend of the rules that painted something (`legend (#rrggbb)`), written as topic labels when `large`. */
  readonly legend: readonly string[];
}

export type ViewpointStyleResult = ViewpointStyle | { readonly code: string; readonly message: string; readonly paths: readonly string[] };

/** `FFRRGGBB`: the 8-digit ARGB of an opaque colour, as BCF writes it. */
const argb = (colour: string): string | null => {
  const rgb = hexRgb(colour);
  return rgb === null
    ? null
    : `FF${rgb
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;
};

/** The style of one viewpoint; `enabled` false = the document as it is (no colouring, no visibility). */
export function styleViewpoint(
  doc: CadDocument,
  viewpointId: string,
  ctx: ExecutionContext | undefined,
  enabled: boolean,
): ViewpointStyleResult {
  if (!enabled) return { scene: doc, colouring: [], coloured: 0, large: false, legend: [] };
  const resolved = resolveReviewStyle(doc, { viewpointId });
  if ('code' in resolved) return resolved;
  const styled = applyReviewStyle(doc, resolved.style, ctx, FRAME_BACKGROUND);
  const groups = new Map<string, string[]>();
  let coloured = 0;
  for (const id of styled.scene.order) {
    const before = doc.entities[id];
    const after = styled.scene.entities[id];
    const colour = after === undefined ? null : argb(after.color);
    if (before === undefined || after === undefined || colour === null || argb(before.color) === colour) continue;
    groups.set(colour, [...(groups.get(colour) ?? []), id]);
    coloured += 1;
  }
  const large = coloured > MAX_COLOURED_COMPONENTS;
  return {
    scene: styled.scene,
    colouring: large ? [] : [...groups].map(([colour, ids]) => ({ colour, ids })),
    coloured,
    large,
    legend: styled.legend.filter((entry) => entry.count > 0).map((entry) => `${entry.legend} (${entry.colour})`),
  };
}
