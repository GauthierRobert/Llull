/**
 * Annotation commands — text labels placed in the document.
 *
 * Text is a 2D annotation kind: `position` is the world-space anchor of the
 * text baseline (work-plane origin, default z=0, normal +Z), consistent with
 * the 2D entity convention (architecture L7). `rotation` orients the work plane.
 *
 * @layer core/commands
 */

import type { CadDocument, DimensionEntity, Entity, Vec3 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { nextId } from '../../lib/id';

/** Clone the document shallowly with a new entity added. Keeps commands pure. */
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}

// ---------------------------------------------------------------------------
// add_text
// ---------------------------------------------------------------------------

interface AddTextParams {
  content: string;
  position: Vec3;
  height: number;
  rotation?: Vec3;
  anchor?: 'left' | 'center' | 'right';
  color?: string;
  layer?: string;
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
export const addText: CommandDefinition<AddTextParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The text string to display. Must not be empty.',
      },
      position: {
        type: 'array',
        description: 'World-space anchor position [x, y, z] of the text. For 2D drafting use z=0.',
        items: { type: 'number' },
      },
      height: {
        type: 'number',
        description: 'Cap-height of the text in model units. Must be greater than 0.',
      },
      rotation: {
        type: 'array',
        description: 'Euler rotation angles [rx, ry, rz] in radians that orient the work plane. Defaults to [0,0,0].',
        items: { type: 'number' },
      },
      anchor: {
        type: 'string',
        description:
          "Horizontal alignment of the text relative to position. " +
          "'left' (default): position is the left edge of the first glyph. " +
          "'center': position is the horizontal midpoint. " +
          "'right': position is the right edge of the last glyph.",
      },
      color: {
        type: 'string',
        description: 'Hex color string, e.g. "#333333". Defaults to "#333333".',
      },
      layer: {
        type: 'string',
        description: 'Layer id to assign the entity to. Defaults to the document default layer.',
      },
    },
    required: ['content', 'position', 'height'],
  },
  run: (doc, { content, position, height, rotation = [0, 0, 0], anchor = 'left', color = '#333333', layer }): CommandResult => {
    if (typeof content !== 'string' || content.trim().length === 0) {
      return {
        document: doc,
        summary: 'add_text: content must be a non-empty string; entity not created.',
        affected: [],
      };
    }

    if (typeof height !== 'number' || height <= 0) {
      return {
        document: doc,
        summary: `add_text: height must be > 0 (got ${height}); entity not created.`,
        affected: [],
      };
    }

    if (
      !Array.isArray(position) ||
      position.length < 3 ||
      typeof position[0] !== 'number' ||
      typeof position[1] !== 'number' ||
      typeof position[2] !== 'number'
    ) {
      return {
        document: doc,
        summary: 'add_text: position must be a [x, y, z] numeric array; entity not created.',
        affected: [],
      };
    }

    const layerId = layer !== undefined && layer in doc.layers ? layer : DEFAULT_LAYER_ID;

    const id = nextId('text');
    const entity = {
      id,
      kind: 'text' as const,
      content,
      height,
      position: [position[0], position[1], position[2]] as Vec3,
      rotation: [
        rotation[0] ?? 0,
        rotation[1] ?? 0,
        rotation[2] ?? 0,
      ] as Vec3,
      anchor,
      layerId,
      color,
    };

    return {
      document: withEntity(doc, entity),
      summary: `add_text: created text entity ${id} — "${content}" at [${position[0]}, ${position[1]}, ${position[2]}], height ${height}, anchor '${anchor}'.`,
      affected: [id],
    };
  },
};

// ---------------------------------------------------------------------------
// add_dimension
// ---------------------------------------------------------------------------

/** Entity kinds that are valid targets for a radial dimension. */
const RADIAL_KINDS: ReadonlySet<string> = new Set(['circle', 'arc', 'ellipse']);

/** Entity kinds that are valid targets for linear/aligned dimensions (2 ids required). */
const LINEAR_KINDS: ReadonlySet<string> = new Set(['line', 'point']);

/** Entity kinds that are valid targets for angular dimensions (3 ids: vertex point + 2 lines, or 3 points). */
const ANGULAR_KINDS: ReadonlySet<string> = new Set(['line', 'point']);

/** Required entityIds count per dimensionKind. */
const REQUIRED_IDS: Record<string, number> = {
  linear: 2,
  aligned: 2,
  radial: 1,
  angular: 3,
};

const VALID_DIMENSION_KINDS: ReadonlySet<string> = new Set(Object.keys(REQUIRED_IDS));

interface AddDimensionParams {
  dimensionKind: string;
  entityIds: string[];
  offset?: number;
  precision?: number;
  label?: string;
  layer?: string;
}

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
export const addDimension: CommandDefinition<AddDimensionParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      dimensionKind: {
        type: 'string',
        description:
          "Type of dimension to create. Must be one of: 'linear' (2 ids), 'aligned' (2 ids), 'radial' (1 id: circle/arc/ellipse), 'angular' (3 ids: vertex point + 2 lines, or 3 points).",
      },
      entityIds: {
        type: 'array',
        description:
          'Ids of the referenced document entities. Count must match the dimensionKind: linear/aligned=2, radial=1, angular=3. All ids must exist in the document.',
        items: { type: 'string' },
      },
      offset: {
        type: 'number',
        description: 'Perpendicular distance (model units) from the measured geometry to the dimension line. Default: 5.',
      },
      precision: {
        type: 'number',
        description: 'Number of decimal places to display for this dimension, overriding the document displayPrecision. Omit to use the document default.',
      },
      label: {
        type: 'string',
        description: "Custom text to display instead of the computed value, e.g. 'REF' or '≈ 42 mm'. Omit to show the computed measurement.",
      },
      layer: {
        type: 'string',
        description: 'Layer id to assign the entity to. Defaults to the document default layer.',
      },
    },
    required: ['dimensionKind', 'entityIds'],
  },
  run: (doc, { dimensionKind, entityIds, offset, precision, label, layer }): CommandResult => {
    // Validate dimensionKind
    if (!VALID_DIMENSION_KINDS.has(dimensionKind)) {
      return {
        document: doc,
        summary: `add_dimension: unknown dimensionKind '${dimensionKind}'. Must be one of: ${[...VALID_DIMENSION_KINDS].join(', ')}.`,
        affected: [],
      };
    }

    // Validate entityIds is an array
    if (!Array.isArray(entityIds) || entityIds.length === 0) {
      return {
        document: doc,
        summary: `add_dimension: entityIds must be a non-empty array of entity ids.`,
        affected: [],
      };
    }

    // Validate entityIds count matches kind
    const required = REQUIRED_IDS[dimensionKind]!;
    if (entityIds.length !== required) {
      return {
        document: doc,
        summary: `add_dimension: dimensionKind '${dimensionKind}' requires exactly ${required} entityId(s), got ${entityIds.length}.`,
        affected: [],
      };
    }

    // Validate all referenced entities exist
    for (const refId of entityIds) {
      if (!(refId in doc.entities)) {
        return {
          document: doc,
          summary: `add_dimension: referenced entity '${refId}' does not exist in the document.`,
          affected: [],
        };
      }
    }

    // Validate entity kind compatibility
    if (dimensionKind === 'radial') {
      const refEntity = doc.entities[entityIds[0]!]!;
      if (!RADIAL_KINDS.has(refEntity.kind)) {
        return {
          document: doc,
          summary: `add_dimension: radial dimension requires a circle, arc, or ellipse entity; got '${refEntity.kind}' (id: '${entityIds[0]}').`,
          affected: [],
        };
      }
    } else if (dimensionKind === 'linear' || dimensionKind === 'aligned') {
      for (const refId of entityIds) {
        const refEntity = doc.entities[refId]!;
        if (!LINEAR_KINDS.has(refEntity.kind)) {
          return {
            document: doc,
            summary: `add_dimension: linear/aligned dimension requires line or point entities; entity '${refId}' has kind '${refEntity.kind}'.`,
            affected: [],
          };
        }
      }
    } else if (dimensionKind === 'angular') {
      for (const refId of entityIds) {
        const refEntity = doc.entities[refId]!;
        if (!ANGULAR_KINDS.has(refEntity.kind)) {
          return {
            document: doc,
            summary: `add_dimension: angular dimension requires line or point entities; entity '${refId}' has kind '${refEntity.kind}'.`,
            affected: [],
          };
        }
      }
    }

    const layerId = layer !== undefined && layer in doc.layers ? layer : DEFAULT_LAYER_ID;
    const id = nextId('dim');

    const entity: DimensionEntity = {
      id,
      kind: 'dimension',
      dimensionKind: dimensionKind as DimensionEntity['dimensionKind'],
      entityIds: [...entityIds],
      position: [0, 0, 0] as Vec3,
      rotation: [0, 0, 0] as Vec3,
      layerId,
      color: '#333333',
      ...(offset !== undefined ? { offset } : {}),
      ...(precision !== undefined ? { precision } : {}),
      ...(label !== undefined ? { label } : {}),
    };

    return {
      document: withEntity(doc, entity),
      summary: `add_dimension: created ${dimensionKind} dimension entity ${id} referencing [${entityIds.join(', ')}]${offset !== undefined ? `, offset ${offset}` : ''}.`,
      affected: [id],
    };
  },
};
