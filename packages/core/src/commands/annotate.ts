/**
 * Annotation commands: text labels and dimensions. Text is a 2D kind: `position` anchors the text
 * baseline on the work plane (default z=0, normal +Z; architecture L7), `rotation` orients it.
 *
 * @layer core/commands
 */

import type { CadDocument, DimensionEntity, Entity, TextEntity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 as vec3 } from './schema';
import { nextId } from '../lib/id';
import { commitEntity } from './commitEntity';
import { noop } from './noop';

type TextAnchor = NonNullable<TextEntity['anchor']>;

/** `layer` when it names an existing layer, else the default layer. */
function layerIdOrDefault(doc: CadDocument, layer: string | undefined): string {
  return layer !== undefined && layer in doc.layers ? layer : DEFAULT_LAYER_ID;
}

/**
 * @command add_text
 * @pure
 * @layer core/commands
 * @affects creates 1 text entity
 * @invariant content is non-empty; height > 0; position is a valid [x,y,z] triple
 * @failure empty content -> no-op, affected:[]
 * @failure height <= 0 -> no-op, affected:[]
 * @failure missing or invalid position -> no-op, affected:[]
 */
export const addText = defineCommand({
  name: 'add_text',
  description:
    'Place an annotation text label in the document. ' +
    '`content` is the text string (must not be empty). ' +
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
      .describe(
        'Euler rotation angles [rx, ry, rz] in radians that orient the work plane. Defaults to [0,0,0].',
      )
      .optional(),
    anchor: z
      .string()
      .describe(
        'Horizontal alignment of the text relative to position. ' +
          "'left' (default): position is the left edge of the first glyph. " +
          "'center': position is the horizontal midpoint. " +
          "'right': position is the right edge of the last glyph.",
      )
      .optional(),
    color: z
      .string()
      .describe('Hex color string, e.g. "#333333". Defaults to "#333333".')
      .optional(),
    layer: z
      .string()
      .describe('Layer id to assign the entity to. Defaults to the document default layer.')
      .optional(),
  }),
  run: (
    doc,
    { content, position, height, rotation = [0, 0, 0], anchor = 'left', color = '#333333', layer },
  ): CommandResult => {
    if (content.trim().length === 0) {
      return noop(doc, 'add_text: content must be a non-empty string; entity not created.');
    }

    if (height <= 0) {
      return noop(doc, `add_text: height must be > 0 (got ${height}); entity not created.`);
    }

    if (position.length < 3) {
      return noop(doc, 'add_text: position must be a [x, y, z] numeric array; entity not created.');
    }

    const id = nextId('text');
    const entity = {
      id,
      kind: 'text' as const,
      content,
      height,
      position: [position[0], position[1], position[2]] as Vec3,
      rotation: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0] as Vec3,
      anchor: anchor as TextAnchor,
      layerId: layerIdOrDefault(doc, layer),
      color,
    };

    return commitEntity(
      doc,
      entity,
      `add_text: created text entity ${id} — "${content}" at [${position[0]}, ${position[1]}, ${position[2]}], height ${height}, anchor '${anchor}'.`,
    );
  },
});

/** Referenced entity kinds and entityIds count per dimensionKind. */
const DIMENSION_RULES: Record<string, { ids: number; kinds: ReadonlySet<string> }> = {
  linear: { ids: 2, kinds: new Set(['line', 'point']) },
  aligned: { ids: 2, kinds: new Set(['line', 'point']) },
  radial: { ids: 1, kinds: new Set(['circle', 'arc', 'ellipse']) },
  angular: { ids: 3, kinds: new Set(['line', 'point']) },
};

/**
 * @command add_dimension
 * @pure
 * @layer core/commands
 * @affects creates 1 dimension entity
 * @invariant dimensionKind is 'linear'|'aligned'|'radial'|'angular'; entityIds length matches kind; all referenced entities exist
 * @failure unknown dimensionKind -> no-op, affected:[]
 * @failure wrong entityIds length for kind -> no-op, affected:[]
 * @failure any referenced entity id missing from document -> no-op, affected:[]
 * @failure incompatible referenced entity kind (radial on non-circle/arc/ellipse; angular/linear on incompatible kind) -> no-op, affected:[]
 */
export const addDimension = defineCommand({
  name: 'add_dimension',
  description:
    'Place an associative dimension annotation in the document. ' +
    '`dimensionKind` controls the measurement type: ' +
    "'linear' — straight-line distance between 2 line or point entities (entityIds length=2); " +
    "'aligned' — distance parallel to the segment between 2 line or point entities (entityIds length=2); " +
    "'radial' — radius of a circle, arc, or ellipse entity (entityIds length=1); " +
    "'angular' — angle at the vertex between 2 line segments or 3 points (entityIds length=3: vertex point first, then 2 line or point entities). " +
    '`entityIds` is an array of existing entity ids whose geometry the dimension measures; the count must match the kind. ' +
    'Optional `offset` is the perpendicular distance (model units) from the measured geometry to the dimension line (default 5). ' +
    'Optional `precision` overrides the document display precision (decimal places) for this dimension. ' +
    "Optional `label` replaces the computed numeric value with a custom string (e.g. 'REF' or '≈ 42 mm'). " +
    'Optional `layer` is the target layer id.',
  params: z.object({
    dimensionKind: z
      .string()
      .describe(
        "Type of dimension to create. Must be one of: 'linear' (2 ids), 'aligned' (2 ids), 'radial' (1 id: circle/arc/ellipse), 'angular' (3 ids: vertex point + 2 lines, or 3 points).",
      ),
    entityIds: z
      .array(z.string())
      .describe(
        'Ids of the referenced document entities. Count must match the dimensionKind: linear/aligned=2, radial=1, angular=3. All ids must exist in the document.',
      ),
    offset: z
      .number()
      .describe(
        'Perpendicular distance (model units) from the measured geometry to the dimension line. Default: 5.',
      )
      .optional(),
    precision: z
      .number()
      .describe(
        'Number of decimal places to display for this dimension, overriding the document displayPrecision. Omit to use the document default.',
      )
      .optional(),
    label: z
      .string()
      .describe(
        "Custom text to display instead of the computed value, e.g. 'REF' or '≈ 42 mm'. Omit to show the computed measurement.",
      )
      .optional(),
    layer: z
      .string()
      .describe('Layer id to assign the entity to. Defaults to the document default layer.')
      .optional(),
  }),
  run: (doc, { dimensionKind, entityIds, offset, precision, label, layer }): CommandResult => {
    const rule = DIMENSION_RULES[dimensionKind];
    if (!rule) {
      return noop(
        doc,
        `add_dimension: unknown dimensionKind '${dimensionKind}'. Must be one of: ${Object.keys(DIMENSION_RULES).join(', ')}.`,
      );
    }
    if (entityIds.length === 0) {
      return noop(doc, `add_dimension: entityIds must be a non-empty array of entity ids.`);
    }
    if (entityIds.length !== rule.ids) {
      return noop(
        doc,
        `add_dimension: dimensionKind '${dimensionKind}' requires exactly ${rule.ids} entityId(s), got ${entityIds.length}.`,
      );
    }
    for (const refId of entityIds) {
      if (!(refId in doc.entities)) {
        return noop(
          doc,
          `add_dimension: referenced entity '${refId}' does not exist in the document.`,
        );
      }
    }
    for (const refId of entityIds) {
      const { kind } = doc.entities[refId] as Entity;
      if (rule.kinds.has(kind)) continue;
      return noop(
        doc,
        dimensionKind === 'radial'
          ? `add_dimension: radial dimension requires a circle, arc, or ellipse entity; got '${kind}' (id: '${refId}').`
          : `add_dimension: ${dimensionKind === 'angular' ? 'angular' : 'linear/aligned'} dimension requires line or point entities; entity '${refId}' has kind '${kind}'.`,
      );
    }

    const id = nextId('dim');

    const entity: DimensionEntity = {
      id,
      kind: 'dimension',
      dimensionKind: dimensionKind as DimensionEntity['dimensionKind'],
      entityIds: [...entityIds],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: layerIdOrDefault(doc, layer),
      color: '#333333',
      ...(offset !== undefined ? { offset } : {}),
      ...(precision !== undefined ? { precision } : {}),
      ...(label !== undefined ? { label } : {}),
    };

    return commitEntity(
      doc,
      entity,
      `add_dimension: created ${dimensionKind} dimension entity ${id} referencing [${entityIds.join(', ')}]${offset !== undefined ? `, offset ${offset}` : ''}.`,
    );
  },
});
