/** text_outline — the exact outline of a font text: loops, area, length, advance width and per-glyph topology (03 WRP M1). */

import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { flattenLoop, loopArea, loopBox, type OutlineLoop } from '../../lib/font/outline';
import { isOutlineFailure, outlineOfText } from './textPath';
import type { Vec2 } from '../../model/vectors';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { isFontFailure, loadFont } from './fontStore';
import { wrapData } from './conventions';

/** Points kept per loop in `output: "loops"` (a longer loop is thinned evenly). */
const MAX_LOOP_POINTS = 2000;
const GLYPH_PAGE = 200;

const thin = (points: Vec2[]): Vec2[] => {
  if (points.length <= MAX_LOOP_POINTS) return points;
  const step = points.length / MAX_LOOP_POINTS;
  return Array.from({ length: MAX_LOOP_POINTS }, (_, k) => points[Math.floor(k * step)] as Vec2);
};

const polyline = (loop: OutlineLoop): Vec2[] => thin(flattenLoop(loop, 16));

/**
 * @affects none (read-only)
 * @invariant area, outline length and loop counts are exact (Green's theorem and closed-form arc length of the quadratic TrueType segments), in document units
 * @failure unknown id / text without font -> coded no-op (WRP_ENTITY_NOT_FOUND, WRP_TEXT_NO_FONT); font bytes lost or damaged -> WRP_FONT_UNAVAILABLE / WRP_FONT_PARSE
 */
export const textOutlineCommand = defineCommand({
  name: 'text_outline',
  description:
    'Outline of a text entity that has a font (add_text with font=...): the closed glyph loops that extrude_profile and emboss_on_face use. Returns ' +
    '`data` with loops (every contour), outerLoops, holes, area (document units squared, exact), outlineLength, advanceWidth (widest line, document ' +
    'units), bbox in the text plane relative to the text position, font {family, sha256}, `unverified` (the font bytes are not pinned), and ' +
    'provenance. Lengths follow the document unit (lengthUnit in the result). `output: "glyphs"` adds per-character topology (contours, holes, area in ' +
    'font units squared) paged by `offset` / `limit`; `output: "loops"` adds each region as flattened polylines (at most 2000 points per loop). ' +
    '`kerning: false` ignores the font kern pairs (advance widths only). Next: emboss_on_face, extrude_profile, wrap_to_face. Unmapped characters ' +
    'are listed in data.missingCharacters and the summary (WRP_GLYPH_MISSING, a warning). Refusals carry error.code WRP_TEXT_NO_FONT, WRP_ENTITY_NOT_FOUND.',
  params: z.object({
    id: z.string().describe('Id of a text entity created with a font (add_text font=...).'),
    output: z
      .enum(['summary', 'glyphs', 'loops'])
      .optional()
      .describe('summary (default): totals only; glyphs: also one record per character; loops: also the region polylines.'),
    kerning: z.boolean().optional().describe('Apply the font kern pairs. Default: the text entity setting (true).'),
    offset: z.number().int().min(0).optional().describe('First glyph record returned with output "glyphs". Default 0.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(`Most glyph records returned with output "glyphs". Default ${GLYPH_PAGE}.`),
  }),
  annotations: { readOnly: true },
  run: (doc, params): CommandResult => {
    const reject = (code: string, message: string, ids: string[] = []): CommandResult =>
      wrapRejection(doc, 'text_outline', code, message, ids, ['id']);
    const entity = doc.entities[params.id];
    if (entity === undefined) return reject('WRP_ENTITY_NOT_FOUND', `entity '${params.id}' not found`, [params.id]);
    if (entity.kind !== 'text' || entity.font === undefined)
      return reject('WRP_TEXT_NO_FONT', `entity '${params.id}' (${entity.kind}) is not a text with a font`, [params.id]);
    const loaded = loadFont(doc, entity.font);
    if (isFontFailure(loaded)) return reject(loaded.code, loaded.message, [params.id]);
    const outline = outlineOfText(doc, entity, loaded.font, params.kerning === undefined ? {} : { kerning: params.kerning });
    if (isOutlineFailure(outline)) return reject(outline.code, outline.message, [params.id]);
    const { layout } = outline;
    const mode = params.output ?? 'summary';
    const from = params.offset ?? 0;
    const glyphs =
      mode === 'glyphs'
        ? layout.glyphs.slice(from, from + (params.limit ?? GLYPH_PAGE)).map((placed) => {
            const loops = placed.glyph === 0 ? [] : loaded.font.outline(placed.glyph);
            const areas = loops.map(loopArea);
            const boxes = loops.map(loopBox).filter((box): box is NonNullable<typeof box> => box !== null);
            return {
              char: placed.character,
              glyph: placed.glyph,
              advance: loaded.font.advance(placed.glyph),
              contours: loops.length,
              holes: areas.filter((area) => area > 0).length,
              areaFontUnits2: -areas.reduce((sum, area) => sum + area, 0),
              bbox:
                boxes.length === 0
                  ? null
                  : [
                      Math.min(...boxes.map((box) => box.min[0])),
                      Math.min(...boxes.map((box) => box.min[1])),
                      Math.max(...boxes.map((box) => box.max[0])),
                      Math.max(...boxes.map((box) => box.max[1])),
                    ],
            };
          })
        : undefined;
    const regions =
      mode === 'loops'
        ? outline.regions.map((region) => ({ area: region.area, outer: polyline(region.outer), holes: region.holes.map(polyline) }))
        : undefined;
    const kind =
      loaded.font.format === 'stroke'
        ? 'single-line strokes'
        : loaded.font.format === 'cff'
          ? 'CFF cubic outlines'
          : 'TrueType quadratic outlines';
    const method = outline.bent
      ? `${kind} bent along a curve (polygonal)`
      : outline.united
        ? `${kind}, overlapping contours united on polygons`
        : `${kind}, exact Green area`;
    const data = wrapData(
      doc,
      {
        id: params.id,
        loops: outline.loopCount,
        outerLoops: outline.regions.length,
        holes: outline.holeCount,
        area: outline.area,
        outlineLength: outline.outlineLength,
        advanceWidth: layout.advanceWidth,
        lines: layout.lines,
        bbox: outline.bbox,
        height: entity.height,
        scale: layout.scale,
        exact: !outline.united && !outline.bent,
        singleLine: loaded.font.singleLine,
        strokes: outline.strokes.length,
        ...(outline.bent ? { onCurve: entity.onCurve } : {}),
        font: { family: loaded.record.family, sha256: loaded.record.blob },
        capHeight: { fontUnits: loaded.record.capHeight, source: loaded.record.capHeightSource },
        missingCharacters: layout.missing,
        warnings: layout.missing.length === 0 ? [] : [{ code: 'WRP_GLYPH_MISSING', characters: layout.missing }],
        ...(glyphs === undefined ? {} : { glyphs }),
        ...(regions === undefined ? {} : { regions }),
      },
      {
        unverified: !loaded.record.provenance.verified,
        provenance: {
          method,
          font: { family: loaded.record.family, sha256: loaded.record.blob },
          inputs: { content: entity.content, height: entity.height, kerning: params.kerning ?? entity.kerning ?? true },
        },
      },
    );
    const missing =
      layout.missing.length === 0
        ? ''
        : ` Warning WRP_GLYPH_MISSING: no glyph for ${layout.missing.map((c) => JSON.stringify(c)).join(', ')}.`;
    return report(
      doc,
      `text_outline: "${entity.content}" in ${loaded.record.family} ${loaded.record.style}, cap height ${entity.height} ${doc.units}: ${outline.loopCount} loops (${outline.regions.length} outer, ${outline.holeCount} holes), area ${outline.area.toPrecision(10)} ${doc.units}^2, outline ${outline.outlineLength.toPrecision(8)} ${doc.units}, advance ${layout.advanceWidth.toPrecision(8)} ${doc.units}.${missing}`,
      data,
    );
  },
});
