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
import { MAX_DISPLAY_PRECISION } from '../limits';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing, formatDimensionValue } from '../../geometry/dimensionAnnotation';

type TextAnchor = NonNullable<TextEntity['anchor']>;

/**
 * @affects creates 1 text entity
 * @invariant content is non-empty; height > 0; position is a valid [x,y,z] triple
 * @failure empty content -> no-op, affected:[]
 * @failure height <= 0 -> no-op, affected:[]
 * @failure missing or invalid position -> no-op, affected:[]
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
    'Optional `color` is a hex string (e.g. "#333333"). Optional `layer` is the target layer id.',
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
    layer: layerIdField(),
  }),
  run: (doc, { content, position, height, rotation = [0, 0, 0], anchor = 'left', color = '#333333', layer }): CommandResult => {
    if (content.trim().length === 0) return noop(doc, 'add_text: content must be a non-empty string; entity not created.');
    if (height <= 0) return noop(doc, `add_text: height must be > 0 (got ${height}); entity not created.`);
    if (position.length < 3) return noop(doc, 'add_text: position must be a [x, y, z] numeric array; entity not created.');
    const id = nextId('text');
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
    };
    return commitEntity(
      doc,
      entity,
      `add_text: created text entity ${id} — "${content}" at [${position[0]}, ${position[1]}, ${position[2]}], height ${height}, anchor '${anchor}'.`,
    );
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
