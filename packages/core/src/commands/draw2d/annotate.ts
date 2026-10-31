/**
 * Annotation commands: text labels and dimensions. Text is a 2D kind: `position` anchors the text baseline on the work plane (default z=0,
 * normal +Z; architecture L7), `rotation` orients it.
 */

import { type DimensionEntity, type Entity, type TextEntity, type Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z, looseVec3 as vec3, layerIdField } from '../schema';
import { nextId } from '../../lib/id';
import { commitEntity } from '../entity/commitEntity';
import { noop } from '../noop';
import { existingLayerOrDefault } from '../solids/shared';
import { entityCurves } from '../../geometry/entityCurves';
import { MAX_DISPLAY_PRECISION } from '../limits';
import { MAX_TEXT_CHARACTERS } from '../../lib/font/layout';
import { isFontFailure, loadFont, resolveFont } from '../wrap/fontStore';
import { wrapRejection } from '../wrap/codes';
import { variationField } from '../wrap/variationField';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing, formatDimensionValue } from '../../geometry/dimensionAnnotation';

type TextAnchor = NonNullable<TextEntity['anchor']>;

/**
 * @affects creates 1 text entity
 * @invariant content is non-empty; height > 0; position is a valid [x,y,z] triple
 * @failure empty content -> no-op, affected:[]
 * @failure height <= 0 -> no-op, affected:[]
 * @failure missing or invalid position -> no-op, affected:[]
 * @invariant with `font` the text is a closed profile (glyph outlines) and the font (a document record, or a bundled one embedded now) travels with the document
 * @failure direction vertical without a font -> WRP_TEXT_NO_FONT; vertical together with onCurve -> WRP_TEXT_VERTICAL_CURVE
 * @failure unknown font -> WRP_FONT_UNAVAILABLE; over 2000 characters with a font -> WRP_TEXT_TOO_LONG; characters the font lacks -> warning WRP_GLYPH_MISSING in data (the step succeeds)
 */
export const addText = defineCommand({
  name: 'add_text',
  description:
    'Place an annotation text label in the document. `content` is the text string (must not be empty). ' +
    '`position` is the world-space anchor [x, y, z] — for 2D annotations use z=0 (the default work plane). ' +
    '`height` is the cap-height in model units (must be > 0). ' +
    'Optional `rotation` is Euler angles [rx, ry, rz] in radians that orient the work plane (default [0,0,0]). ' +
    "Optional `anchor` controls horizontal alignment: 'left' (default) — position is left edge; " +
    "'center' — position is horizontal midpoint; 'right' — position is right edge. " +
    'Optional `color` is a hex string (e.g. "#333333"). Optional `layer` is the target layer id. ' +
    'Optional `font` (a font id from import_font / list_fonts, or the family of a bundled font such as "Fira Sans") turns the text into a closed outline ' +
    'profile that text_outline, extrude_profile, wrap_to_face and emboss_on_face accept; `height` is then the exact cap height. With a font, ' +
    '`verticalAnchor` (baseline | cap_middle | cap_top), `letterSpacing` (document units after each glyph), `kerning` and `lineSpacing` (newline breaks lines) apply; ' +
    '`direction: "vertical"` stacks the glyphs top to bottom (CJK style, columns to the left; see the `direction` parameter). ' +
    'A single-line font (family "LLULL Single Line", bundled) draws open strokes for engraving: wrap_to_face wraps them as curves and emboss_on_face mode engrave cuts a groove along them. ' +
    '`onCurve` { curveId, offset?, reverse? } bends a font text along a line / arc / circle / polyline / spline of the same sketch plane (the baseline follows the curve, glyphs stand on its ' +
    'left; anchor left / center / right aligns the text to the start / middle / end of the curve, `offset` shifts it along; refused when the text is longer than the curve). ' +
    'Without `font` the text stays an annotation. Characters the font lacks are reported in data.warnings (WRP_GLYPH_MISSING).',
  params: z.object({
    content: z.string().describe('The text string to display. Must not be empty.'),
    position: vec3('World-space anchor position [x, y, z] of the text. For 2D drafting use z=0.'),
    height: z.number().describe('Cap-height of the text in model units. Must be greater than 0.'),
    rotation: z
      .array(z.number())
      .describe('Euler rotation angles [rx, ry, rz] in radians that orient the work plane. Defaults to [0,0,0].')
      .optional(),
    anchor: z
      .string()
      .describe(
        "Horizontal alignment of the text relative to position. 'left' (default): position is the left edge of the first glyph. " +
          "'center': position is the horizontal midpoint. 'right': position is the right edge of the last glyph.",
      )
      .optional(),
    color: z.string().describe('Hex color string, e.g. "#333333". Defaults to "#333333".').optional(),
    font: z
      .string()
      .describe(
        'Font of the outline text: a font id (import_font, list_fonts) or a bundled family name such as "Fira Sans" (embedded in the document on first use).',
      )
      .optional(),
    variation: variationField(),
    verticalAnchor: z
      .enum(['baseline', 'cap_middle', 'cap_top'])
      .describe(
        'Font text only: baseline (default) puts position on the baseline, cap_middle at half the cap height, cap_top on the cap line.',
      )
      .optional(),
    letterSpacing: z.number().describe('Font text only: extra distance in document units added after each glyph. Default 0.').optional(),
    kerning: z.boolean().describe('Font text only: apply the font kern pairs. Default true. Ignored for vertical text.').optional(),
    direction: z
      .enum(['horizontal', 'vertical'])
      .describe(
        'Font text only: horizontal (default) sets the glyphs along the baseline; vertical stacks them top to bottom by the vertical advance of the font (vmtx, ascender - descender without it), each hung from its vertical origin (VORG of a CFF font, else the glyph top + its vmtx top side bearing, else the ascender; x = the middle of its advance width), upright. ' +
          'position is the vertical origin of the FIRST glyph of the first column (the top of its advance box). `verticalAnchor`: baseline and cap_top hang the text down from position, cap_middle centres each column on position.y. `anchor`, per column: center puts the middle of its glyphs on its x, left its left edge, right its right edge, where the first column sits at position.x and a newline starts the next column one vertical line pitch (vhea ascender - descender + gap, else the horizontal line height; times lineSpacing) further LEFT. Not with onCurve.',
      )
      .optional(),
    lineSpacing: z
      .number()
      .positive()
      .describe('Font text only: line pitch as a multiple of the font line height (ascender - descender + line gap). Default 1.')
      .optional(),
    onCurve: z
      .object({
        curveId: z
          .string()
          .describe(
            'Id of a 2D curve entity (line, arc, circle, ellipse, polyline, spline) in the same plane as the text (same rotation).',
          ),
        offset: z.number().optional().describe('Arc length added to the anchor position along the curve, document units. Default 0.'),
        reverse: z
          .boolean()
          .optional()
          .describe('Run along the curve from its end to its start (the text then stands on the other side). Default false.'),
      })
      .describe('Font text only: bend the text along this curve.')
      .optional(),
    layer: layerIdField(),
  }),
  run: (
    doc,
    {
      content,
      position,
      height,
      rotation = [0, 0, 0],
      anchor = 'left',
      color = '#333333',
      layer,
      font,
      variation,
      verticalAnchor,
      letterSpacing,
      kerning,
      direction,
      lineSpacing,
      onCurve,
    },
    ctx,
  ): CommandResult => {
    if (content.trim().length === 0) return noop(doc, 'add_text: content must be a non-empty string; entity not created.');
    if (height <= 0) return noop(doc, `add_text: height must be > 0 (got ${height}); entity not created.`);
    if (position.length < 3) return noop(doc, 'add_text: position must be a [x, y, z] numeric array; entity not created.');
    const id = nextId('text');
    const reject = (code: string, message: string): CommandResult =>
      wrapRejection(doc, 'add_text', code, message, [], [code === 'WRP_FONT_VARIATION' ? 'variation' : 'font']);
    if (onCurve !== undefined) {
      if (font === undefined)
        return wrapRejection(doc, 'add_text', 'WRP_TEXT_NO_FONT', 'onCurve bends outline text: give a font', [], ['onCurve']);
      const curve = doc.entities[onCurve.curveId];
      if (curve === undefined || entityCurves(curve) === null)
        return wrapRejection(
          doc,
          'add_text',
          'WRP_TEXT_CURVE_INVALID',
          `'${onCurve.curveId}' is ${curve === undefined ? 'not in the document' : `a ${curve.kind}, not a 2D curve`}`,
          [onCurve.curveId],
          ['onCurve.curveId'],
        );
      if (curve.rotation.some((angle, k) => Math.abs(angle - (rotation[k] ?? 0)) > 1e-9))
        return wrapRejection(
          doc,
          'add_text',
          'WRP_TEXT_CURVE_PLANE',
          `the curve '${onCurve.curveId}' and the text lie in different planes (rotations differ)`,
          [onCurve.curveId],
          ['rotation'],
        );
    }
    if (direction === 'vertical') {
      if (font === undefined)
        return wrapRejection(
          doc,
          'add_text',
          'WRP_TEXT_NO_FONT',
          'direction vertical lays out outline text: give a font',
          [],
          ['direction'],
        );
      if (onCurve !== undefined)
        return wrapRejection(
          doc,
          'add_text',
          'WRP_TEXT_VERTICAL_CURVE',
          'vertical text cannot follow a curve (onCurve)',
          [],
          ['direction'],
        );
    }
    let target = doc;
    let fontId: string | undefined;
    let missing: string[] = [];
    if (font !== undefined) {
      if ([...content].length > MAX_TEXT_CHARACTERS)
        return wrapRejection(
          doc,
          'add_text',
          'WRP_TEXT_TOO_LONG',
          `${[...content].length} characters exceed ${MAX_TEXT_CHARACTERS}`,
          [],
          ['content'],
        );
      const resolved = resolveFont(doc, ctx, font, variation);
      if (isFontFailure(resolved)) return reject(resolved.code, resolved.message);
      const loaded = loadFont(resolved.document, resolved.record.id);
      if (isFontFailure(loaded)) return reject(loaded.code, loaded.message);
      target = resolved.document;
      fontId = resolved.record.id;
      const unmapped = [...content].filter(
        (character) => character.trim().length > 0 && loaded.font.glyphIndex(character.codePointAt(0) as number) === 0,
      );
      missing = [...new Set(unmapped)];
    }
    const entity = {
      id,
      kind: 'text' as const,
      content,
      height,
      position: [position[0], position[1], position[2]] as Vec3,
      rotation: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0] as Vec3,
      anchor: anchor as TextAnchor,
      layerId: existingLayerOrDefault(doc, layer),
      color,
      ...(fontId === undefined ? {} : { font: fontId }),
      ...(verticalAnchor === undefined ? {} : { verticalAnchor }),
      ...(letterSpacing === undefined ? {} : { letterSpacing }),
      ...(kerning === undefined ? {} : { kerning }),
      ...(direction === undefined ? {} : { direction }),
      ...(lineSpacing === undefined ? {} : { lineSpacing }),
      ...(onCurve === undefined
        ? {}
        : {
            onCurve: {
              curveId: onCurve.curveId,
              ...(onCurve.offset === undefined ? {} : { offset: onCurve.offset }),
              ...(onCurve.reverse === undefined ? {} : { reverse: onCurve.reverse }),
            },
          }),
    };
    const warned =
      missing.length === 0
        ? ''
        : ` Warning WRP_GLYPH_MISSING: the font has no glyph for ${missing.map((c) => JSON.stringify(c)).join(', ')}.`;
    const committed = commitEntity(
      target,
      entity,
      `add_text: created text entity ${id} — "${content}" at [${position[0]}, ${position[1]}, ${position[2]}], height ${height}, anchor '${anchor}'${fontId === undefined ? '' : `, font ${fontId}`}.${warned}`,
    );
    return fontId === undefined
      ? committed
      : {
          ...committed,
          data: { id, font: fontId, warnings: missing.length === 0 ? [] : [{ code: 'WRP_GLYPH_MISSING', characters: missing }] },
        };
  },
});

/** Referenced entity kinds and allowed entityIds counts per dimensionKind. */
const DIMENSION_RULES: Record<string, { ids: readonly number[]; kinds: ReadonlySet<string> }> = {
  linear: { ids: [2], kinds: new Set(['line', 'point']) },
  aligned: { ids: [2], kinds: new Set(['line', 'point']) },
  radial: { ids: [1], kinds: new Set(['circle', 'arc', 'ellipse']) },
  diameter: { ids: [1], kinds: new Set(['circle', 'arc', 'ellipse']) },
  angular: { ids: [2, 3], kinds: new Set(['line', 'point']) },
};

const MEASURED: Record<string, string> = {
  linear: 'linear dimension',
  aligned: 'aligned dimension',
  radial: 'radial dimension, radius',
  diameter: 'diameter dimension',
  angular: 'angular dimension',
};

/**
 * @affects creates 1 dimension entity
 * @invariant dimensionKind is 'linear'|'aligned'|'radial'|'diameter'|'angular'; entityIds length matches kind; all referenced entities exist
 * @invariant summary states the measured value (document units, or degrees for angular)
 * @failure unknown dimensionKind -> no-op, affected:[]
 * @failure wrong entityIds length for kind -> no-op, affected:[]
 * @failure any referenced entity id missing from document -> no-op, affected:[]
 * @failure incompatible referenced entity kind (radial/diameter on non-circle/arc/ellipse; angular/linear on incompatible kind; 2-id angular on a non-line) -> no-op, affected:[]
 * @failure angular from two parallel lines (no vertex) -> no-op, affected:[]
 */
export const addDimension = defineCommand({
  name: 'add_dimension',
  description:
    'Place an associative dimension annotation in the document and report the measured value in the summary. `dimensionKind` controls the measurement type: ' +
    "'linear' — distance between 2 line or point entities, measured along X (horizontal) or along Y (vertical) whichever separation is larger, between their midpoints/positions (entityIds length=2); " +
    "'aligned' — true distance between 2 line or point entities, dimension line parallel to the segment joining them (entityIds length=2); " +
    "'radial' — radius of a circle, arc, or ellipse entity (entityIds length=1); " +
    "'diameter' — diameter of a circle, arc, or ellipse entity, drawn with a Ø prefix (entityIds length=1); " +
    "'angular' — minor angle in degrees: either 2 line entities (the vertex is the intersection of the two infinite lines; parallel lines are rejected) " +
    'or 3 entities (vertex point first, then 2 line or point entities). ' +
    '`entityIds` is an array of existing entity ids whose geometry the dimension measures; the count must match the kind. ' +
    'Optional `offset` is the perpendicular distance (model units) from the measured geometry to the dimension line (default 5); for angular it is the arc radius, ' +
    'and for radial/diameter a value in (0, 2π) is the leader angle in radians (default 5 rad). ' +
    'Optional `precision` overrides the document display precision (decimal places) for this dimension. ' +
    "Optional `tolerance` is drawn after the computed value, e.g. '±0.1', '+0.05/-0.02' or 'H7'. " +
    "Optional `label` replaces the computed value (and tolerance) with a custom string (e.g. 'REF' or '≈ 42 mm'). " +
    'Optional `layer` is the target layer id.',
  params: z.object({
    dimensionKind: z
      .string()
      .describe(
        "Type of dimension to create. Must be one of: 'linear' (2 ids), 'aligned' (2 ids), 'radial' (1 id: circle/arc/ellipse), 'diameter' (1 id: circle/arc/ellipse), 'angular' (2 line ids, or 3 ids: vertex point + 2 lines/points).",
      ),
    entityIds: z
      .array(z.string())
      .describe(
        'Ids of the referenced document entities. Count must match the dimensionKind: linear/aligned=2, radial/diameter=1, angular=2 (lines) or 3 (vertex + 2). All ids must exist in the document.',
      ),
    offset: z
      .number()
      .describe('Perpendicular distance (model units) from the measured geometry to the dimension line. Default: 5.')
      .optional(),
    precision: z
      .number()
      .int()
      .describe(
        'Number of decimal places to display for this dimension, overriding the document displayPrecision. Must be an integer in [0, 20]. Omit to use the document default.',
      )
      .optional(),
    tolerance: z
      .string()
      .describe(
        "Tolerance text drawn after the computed value, e.g. '±0.1', '+0.05/-0.02' or a fit like 'H7'. Ignored when `label` is set.",
      )
      .optional(),
    label: z
      .string()
      .describe("Custom text to display instead of the computed value, e.g. 'REF' or '≈ 42 mm'. Omit to show the computed measurement.")
      .optional(),
    layer: layerIdField(),
  }),
  run: (doc, { dimensionKind, entityIds, offset, precision, tolerance, label, layer }): CommandResult => {
    const rule = DIMENSION_RULES[dimensionKind];
    if (!rule)
      return noop(
        doc,
        `add_dimension: unknown dimensionKind '${dimensionKind}'. Must be one of: ${Object.keys(DIMENSION_RULES).join(', ')}.`,
      );
    if (precision !== undefined && (precision < 0 || precision > MAX_DISPLAY_PRECISION))
      return noop(doc, `add_dimension: precision must be an integer in [0, ${MAX_DISPLAY_PRECISION}] (got ${precision}).`);
    if (entityIds.length === 0) return noop(doc, `add_dimension: entityIds must be a non-empty array of entity ids.`);
    if (!rule.ids.includes(entityIds.length))
      return noop(
        doc,
        `add_dimension: dimensionKind '${dimensionKind}' requires exactly ${rule.ids.join(' or ')} entityId(s), got ${entityIds.length}.`,
      );
    const missing = entityIds.find((refId) => !(refId in doc.entities));
    if (missing !== undefined) return noop(doc, `add_dimension: referenced entity '${missing}' does not exist in the document.`);
    const refs = entityIds.map((refId) => doc.entities[refId] as Entity);
    for (const ref of refs) {
      if (rule.kinds.has(ref.kind)) continue;
      return noop(
        doc,
        dimensionKind === 'radial' || dimensionKind === 'diameter'
          ? `add_dimension: ${dimensionKind} dimension requires a circle, arc, or ellipse entity; got '${ref.kind}' (id: '${ref.id}').`
          : `add_dimension: ${dimensionKind === 'angular' ? 'angular' : 'linear/aligned'} dimension requires line or point entities; entity '${ref.id}' has kind '${ref.kind}'.`,
      );
    }
    const kind = dimensionKind as DimensionEntity['dimensionKind'];
    if (kind === 'angular' && entityIds.length === 2 && refs.some((ref) => ref.kind !== 'line'))
      return noop(doc, 'add_dimension: an angular dimension from 2 ids needs two line entities (use 3 ids for points).');
    const drawing = dimensionDrawing(kind, refs, offset ?? DEFAULT_DIMENSION_OFFSET);
    if (!drawing) return noop(doc, 'add_dimension: the two lines are parallel (or degenerate), so there is no angle to dimension.');
    const id = nextId('dim');
    const toleranceText = tolerance?.trim();
    const entity: DimensionEntity = {
      id,
      kind: 'dimension',
      dimensionKind: kind,
      entityIds: [...entityIds],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: existingLayerOrDefault(doc, layer),
      color: '#333333',
      ...(offset !== undefined ? { offset } : {}),
      ...(precision !== undefined ? { precision } : {}),
      ...(toleranceText ? { tolerance: toleranceText } : {}),
      ...(label !== undefined ? { label } : {}),
    };
    const measured = formatDimensionValue(kind, drawing.value, precision ?? doc.displayPrecision);
    const unit = kind === 'angular' ? '' : ` ${doc.units}`;
    return commitEntity(
      doc,
      entity,
      `add_dimension: created ${MEASURED[dimensionKind]} ${measured}${unit} (entity ${id}) referencing [${entityIds.join(', ')}]` +
        `${offset !== undefined ? `, offset ${offset}` : ''}${toleranceText ? `, tolerance ${toleranceText}` : ''}${label !== undefined ? `, label '${label}'` : ''}.`,
    );
  },
});
