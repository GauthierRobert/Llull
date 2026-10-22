/**
 * Outline of a `TextEntity` with a font (03 WRP): its glyph loops grouped into regions, in the text's own plane coordinates (document units, origin
 * at the entity `position`, anchored as the entity says). Pure; the font bytes come from the caller.
 * @invariant region areas are exact (Green's theorem on the quadratic segments); loops are never flattened unless overlapping contours were united
 */

import type { TextEntity } from '../model/types';
import type { Vec2 } from '../model/vectors';
import { fillRegions, type FillRegion } from '../lib/font/fill';
import type { ParsedFont } from '../lib/font/font';
import { FontError } from '../lib/font/reader';
import { layoutText, MAX_TEXT_CHARACTERS, type TextLayout } from '../lib/font/layout';
import { loopArea, loopBox, loopLength, type OutlineLoop } from '../lib/font/outline';

interface TextRegion extends FillRegion {
  /** Outer area minus hole areas, document units squared. */
  readonly area: number;
}

export interface TextOutline {
  readonly layout: TextLayout;
  readonly regions: readonly TextRegion[];
  /** Overlapping contours were united on polygons (the outline is then polygonal, not exact). */
  readonly united: boolean;
  readonly area: number;
  readonly outlineLength: number;
  readonly loopCount: number;
  readonly holeCount: number;
  readonly bbox: { readonly min: Vec2; readonly max: Vec2 } | null;
}

type TextOutlineError = 'too_long' | 'self_intersect' | 'font_parse';
export type TextOutlineResult = TextOutline | { readonly error: TextOutlineError; readonly message: string };

/** The stable command code of a `textOutline` error. */
export const outlineErrorCode = (error: TextOutlineError): string =>
  error === 'too_long' ? 'WRP_TEXT_TOO_LONG' : error === 'font_parse' ? 'WRP_FONT_PARSE' : 'WRP_PROFILE_SELF_INTERSECT';

/** @failure more than MAX_TEXT_CHARACTERS characters, contours that cross in a way the union cannot repair, or a glyph the font cannot deliver -> `{ error }` */
export function textOutline(
  entity: Pick<TextEntity, 'content' | 'height' | 'anchor' | 'verticalAnchor' | 'letterSpacing' | 'kerning' | 'lineSpacing'>,
  font: ParsedFont,
): TextOutlineResult {
  try {
    return outlineOf(entity, font);
  } catch (error) {
    if (error instanceof FontError) return { error: 'font_parse', message: error.message };
    throw error;
  }
}

function outlineOf(
  entity: Pick<TextEntity, 'content' | 'height' | 'anchor' | 'verticalAnchor' | 'letterSpacing' | 'kerning' | 'lineSpacing'>,
  font: ParsedFont,
): TextOutlineResult {
  if ([...entity.content].length > MAX_TEXT_CHARACTERS)
    return { error: 'too_long', message: `${[...entity.content].length} characters exceed the limit of ${MAX_TEXT_CHARACTERS}` };
  const layout = layoutText(font, entity.content, {
    height: entity.height,
    anchor: entity.anchor ?? 'left',
    verticalAnchor: entity.verticalAnchor ?? 'baseline',
    letterSpacing: entity.letterSpacing ?? 0,
    kerning: entity.kerning ?? true,
    lineSpacing: entity.lineSpacing ?? 1,
  });
  const fill = fillRegions(layout.loops);
  if ('error' in fill) return { error: 'self_intersect', message: `glyph contour ${fill.loop} crosses another contour` };
  const regions: TextRegion[] = fill.regions.map((region) => ({
    ...region,
    area: Math.abs(loopArea(region.outer)) - region.holes.reduce((sum, hole) => sum + Math.abs(loopArea(hole)), 0),
  }));
  const loops: OutlineLoop[] = regions.flatMap((region) => [region.outer, ...region.holes]);
  const boxes = loops.map(loopBox).filter((box): box is NonNullable<typeof box> => box !== null);
  return {
    layout,
    regions,
    united: fill.united,
    area: regions.reduce((sum, region) => sum + region.area, 0),
    outlineLength: loops.reduce((sum, loop) => sum + loopLength(loop), 0),
    loopCount: loops.length,
    holeCount: regions.reduce((sum, region) => sum + region.holes.length, 0),
    bbox:
      boxes.length === 0
        ? null
        : {
            min: [Math.min(...boxes.map((box) => box.min[0])), Math.min(...boxes.map((box) => box.min[1]))],
            max: [Math.max(...boxes.map((box) => box.max[0])), Math.max(...boxes.map((box) => box.max[1]))],
          },
  };
}
