/**
 * Outline of a `TextEntity` with a font (03 WRP): its glyph loops grouped into regions, in the text's own plane coordinates (document units, origin
 * at the entity `position`, anchored as the entity says). Pure; the font bytes come from the caller. A single-line (stroke) font has no regions: its outline is the open strokes.
 * With a `mapper` (text on a curve) every loop and stroke is flattened and bent along the curve first, so the outline is polygonal.
 * @invariant region areas are exact (Green's theorem on the quadratic / cubic segments) unless overlapping contours were united or the text was bent; loops are never flattened otherwise
 */

import type { TextEntity } from '../model/types';
import type { Vec2 } from '../model/vectors';
import { fillRegions, type FillRegion } from '../lib/font/fill';
import type { ParsedFont } from '../lib/font/font';
import { FontError } from '../lib/font/reader';
import { layoutText, MAX_TEXT_CHARACTERS, type TextLayout } from '../lib/font/layout';
import { flattenLoop, loopArea, loopBox, loopLength, type OutlineLoop, type OutlineSegment } from '../lib/font/outline';
import type { PointMapper } from './textOnCurve';

interface TextRegion extends FillRegion {
  /** Outer area minus hole areas, document units squared. */
  readonly area: number;
}

export interface TextOutline {
  readonly layout: TextLayout;
  readonly regions: readonly TextRegion[];
  /** Open strokes of a single-line font (empty otherwise), placed like the loops. */
  readonly strokes: readonly (readonly Vec2[])[];
  /** Overlapping contours were united on polygons (the outline is then polygonal, not exact). */
  readonly united: boolean;
  /** The text was bent along a curve (the outline is then polygonal). */
  readonly bent: boolean;
  readonly area: number;
  readonly outlineLength: number;
  readonly loopCount: number;
  readonly holeCount: number;
  readonly bbox: { readonly min: Vec2; readonly max: Vec2 } | null;
}

type TextOutlineError = 'too_long' | 'self_intersect' | 'font_parse' | 'off_curve';
export type TextOutlineResult = TextOutline | { readonly error: TextOutlineError; readonly message: string };

/** The stable command code of a `textOutline` error. */
export const outlineErrorCode = (error: TextOutlineError): string =>
  error === 'too_long'
    ? 'WRP_TEXT_TOO_LONG'
    : error === 'font_parse'
      ? 'WRP_FONT_PARSE'
      : error === 'off_curve'
        ? 'WRP_TEXT_CURVE_TOO_SHORT'
        : 'WRP_PROFILE_SELF_INTERSECT';

type OutlineEntity = Pick<TextEntity, 'content' | 'height' | 'anchor' | 'verticalAnchor' | 'letterSpacing' | 'kerning' | 'lineSpacing'>;

/** @failure more than MAX_TEXT_CHARACTERS characters, contours that cross in a way the union cannot repair, a glyph the font cannot deliver, text beyond the end of its curve -> `{ error }` */
export function textOutline(entity: OutlineEntity, font: ParsedFont, mapper?: PointMapper): TextOutlineResult {
  try {
    return outlineOf(entity, font, mapper);
  } catch (error) {
    if (error instanceof FontError) return { error: 'font_parse', message: error.message };
    throw error;
  }
}

/** Points per curved segment and the longest straight piece (a fraction of the cap height) when a loop is bent. */
const CURVE_POINTS = 12;
const STEP_RATIO = 1 / 12;

/** `from -> ... -> to` of a segment as points (the last point excluded), straight edges cut into pieces of at most `step`. */
function pieces(segment: OutlineSegment, step: number): Vec2[] {
  if (segment.kind !== 'line') return flattenLoop([segment], CURVE_POINTS);
  const count = Math.max(1, Math.ceil(Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]) / step));
  return Array.from(
    { length: count },
    (_, k): Vec2 => [
      segment.from[0] + ((segment.to[0] - segment.from[0]) * k) / count,
      segment.from[1] + ((segment.to[1] - segment.from[1]) * k) / count,
    ],
  );
}

function bendLoop(loop: OutlineLoop, mapper: PointMapper, step: number): OutlineLoop | null {
  const mapped: Vec2[] = [];
  for (const point of loop.flatMap((segment) => pieces(segment, step))) {
    const out = mapper(point);
    if (out === null) return null;
    mapped.push(out);
  }
  return mapped.map((from, k) => ({ kind: 'line' as const, from, to: mapped[(k + 1) % mapped.length] as Vec2 }));
}

function bendStroke(stroke: readonly Vec2[], mapper: PointMapper, step: number): Vec2[] | null {
  const dense = stroke.flatMap((from, k) => {
    const to = stroke[k + 1];
    return to === undefined ? [from] : pieces({ kind: 'line', from, to }, step);
  });
  const mapped = dense.map(mapper);
  return mapped.some((p) => p === null) ? null : (mapped as Vec2[]);
}

const strokeLength = (stroke: readonly Vec2[]): number =>
  stroke.reduce(
    (sum, point, k) => (k === 0 ? 0 : sum + Math.hypot(point[0] - (stroke[k - 1] as Vec2)[0], point[1] - (stroke[k - 1] as Vec2)[1])),
    0,
  );

function outlineOf(entity: OutlineEntity, font: ParsedFont, mapper?: PointMapper): TextOutlineResult {
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
  const step = entity.height * STEP_RATIO;
  const off = { error: 'off_curve' as const, message: 'the text runs beyond the end of its curve' };
  let loops: readonly OutlineLoop[] = layout.loops;
  let strokes: readonly (readonly Vec2[])[] = layout.strokes;
  if (mapper !== undefined) {
    const bentLoops = layout.loops.map((loop) => bendLoop(loop, mapper, step));
    const bentStrokes = layout.strokes.map((stroke) => bendStroke(stroke, mapper, step));
    if (bentLoops.some((loop) => loop === null) || bentStrokes.some((stroke) => stroke === null)) return off;
    loops = bentLoops as OutlineLoop[];
    strokes = bentStrokes as Vec2[][];
  }
  const fill = fillRegions(loops);
  if ('error' in fill) return { error: 'self_intersect', message: `glyph contour ${fill.loop} crosses another contour` };
  const regions: TextRegion[] = fill.regions.map((region) => ({
    ...region,
    area: Math.abs(loopArea(region.outer)) - region.holes.reduce((sum, hole) => sum + Math.abs(loopArea(hole)), 0),
  }));
  const outlineLoops: OutlineLoop[] = regions.flatMap((region) => [region.outer, ...region.holes]);
  const boxes = outlineLoops.map(loopBox).filter((box): box is NonNullable<typeof box> => box !== null);
  const points = [...boxes.flatMap((box) => [box.min, box.max]), ...strokes.flat()];
  return {
    layout,
    regions,
    strokes,
    united: fill.united,
    bent: mapper !== undefined,
    area: regions.reduce((sum, region) => sum + region.area, 0),
    outlineLength:
      outlineLoops.reduce((sum, loop) => sum + loopLength(loop), 0) + strokes.reduce((sum, stroke) => sum + strokeLength(stroke), 0),
    loopCount: outlineLoops.length,
    holeCount: regions.reduce((sum, region) => sum + region.holes.length, 0),
    bbox:
      points.length === 0
        ? null
        : {
            min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
            max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
          },
  };
}
