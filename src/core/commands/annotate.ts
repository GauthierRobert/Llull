/**
 * Annotation commands — text labels placed in the document.
 *
 * Text is a 2D annotation kind: `position` is the world-space anchor of the
 * text baseline (work-plane origin, default z=0, normal +Z), consistent with
 * the 2D entity convention (architecture L7). `rotation` orients the work plane.
 *
 * @layer core/commands
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
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
