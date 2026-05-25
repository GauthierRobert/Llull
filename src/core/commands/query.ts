/**
 * Query commands — read-only document inspection that returns structured data.
 *
 * @layer core/commands
 *
 * These commands never mutate the document. They return the unchanged doc,
 * `affected:[]`, a factual `summary`, and structured results in `data`.
 * Designed so AI/MCP agents can filter and locate entities by meaning rather
 * than juggling generated ids.
 */

import type { Entity, EntityKind } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { entityBounds } from './scene';
import type { Bounds } from './scene';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** A compact descriptor of one matched entity, safe to return in `data`. */
export interface EntityMatch {
  id: string;
  kind: EntityKind;
  layerId: string;
  name?: string;
  tags?: readonly string[];
}

export interface FindEntitiesResult {
  matches: EntityMatch[];
  count: number;
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/** Returns true when the entity's world-space AABB overlaps the given bbox filter. */
function overlapsBbox(
  e: Entity,
  bboxMin: readonly [number, number, number],
  bboxMax: readonly [number, number, number],
): boolean {
  const b: Bounds = entityBounds(e);
  return (
    b.max[0] >= bboxMin[0] &&
    b.min[0] <= bboxMax[0] &&
    b.max[1] >= bboxMin[1] &&
    b.min[1] <= bboxMax[1] &&
    b.max[2] >= bboxMin[2] &&
    b.min[2] <= bboxMax[2]
  );
}

// ---------------------------------------------------------------------------
// find_entities
// ---------------------------------------------------------------------------

interface FindEntitiesParams {
  kind?: EntityKind;
  layerId?: string;
  name?: string;
  nameExact?: boolean;
  tag?: string;
  bboxMin?: readonly [number, number, number];
  bboxMax?: readonly [number, number, number];
}

/**
 * @command find_entities
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is FindEntitiesResult; document === input doc
 * @failure invalid bbox (bboxMin without bboxMax or vice-versa) -> no-op, affected:[]
 */
export const findEntities: CommandDefinition<FindEntitiesParams> = {
  name: 'find_entities',
  description:
    'Filter entities in the document by any combination of kind, layerId, name (substring ' +
    'or exact), tag, and world-space bounding box (bboxMin/bboxMax). All filters are AND-ed. ' +
    'Returns matched entity descriptors (id, kind, layerId, name, tags) in result.data ' +
    'and a factual summary. Does NOT modify the document. ' +
    'Use this to locate entities by meaning before editing them.',
  paramsSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description:
          'Filter by entity kind. One of: "box", "cylinder", "sphere", "extrusion", "mesh", ' +
          '"line", "polyline", "arc", "circle", "rectangle", "point". Omit to match all kinds.',
        enum: ['box', 'cylinder', 'sphere', 'extrusion', 'mesh', 'line', 'polyline', 'arc', 'circle', 'rectangle', 'point'],
      },
      layerId: {
        type: 'string',
        description: 'Filter by layer id. Only entities assigned to this layer are returned. Omit to match all layers.',
      },
      name: {
        type: 'string',
        description:
          'Filter by entity name. By default performs a case-insensitive substring match. ' +
          'Set nameExact:true for a case-sensitive exact match. Omit to match all names.',
      },
      nameExact: {
        type: 'boolean',
        description:
          'When true, the name filter requires an exact case-sensitive match instead of a substring match. Default: false.',
      },
      tag: {
        type: 'string',
        description:
          'Filter to entities that have this exact tag string in their tags array. Omit to match all entities regardless of tags.',
      },
      bboxMin: {
        type: 'array',
        description:
          'World-space minimum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMax. ' +
          'Only entities whose world-space AABB overlaps this box are returned.',
        items: { type: 'number' },
      },
      bboxMax: {
        type: 'array',
        description:
          'World-space maximum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMin. ' +
          'Only entities whose world-space AABB overlaps this box are returned.',
        items: { type: 'number' },
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const { kind, layerId, name, nameExact = false, tag, bboxMin, bboxMax } = params as FindEntitiesParams;

    // Validate bbox: must supply both or neither.
    const hasBboxMin = bboxMin !== undefined;
    const hasBboxMax = bboxMax !== undefined;
    if (hasBboxMin !== hasBboxMax) {
      return {
        document: doc,
        summary: 'find_entities: bboxMin and bboxMax must both be provided or both omitted.',
        affected: [],
      };
    }

    const matches: EntityMatch[] = [];

    for (const id of doc.order) {
      const e = doc.entities[id];
      if (!e) continue;

      // kind filter
      if (kind !== undefined && e.kind !== kind) continue;

      // layerId filter
      if (layerId !== undefined && e.layerId !== layerId) continue;

      // name filter
      if (name !== undefined) {
        const entityName = e.name;
        if (entityName === undefined) continue;
        if (nameExact) {
          if (entityName !== name) continue;
        } else {
          if (!entityName.toLowerCase().includes(name.toLowerCase())) continue;
        }
      }

      // tag filter
      if (tag !== undefined) {
        const entityTags = e.tags;
        if (!entityTags || !entityTags.includes(tag)) continue;
      }

      // bbox filter
      if (hasBboxMin && bboxMin !== undefined && bboxMax !== undefined) {
        if (!overlapsBbox(e, bboxMin, bboxMax)) continue;
      }

      matches.push({
        id: e.id,
        kind: e.kind,
        layerId: e.layerId,
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.tags !== undefined ? { tags: e.tags } : {}),
      });
    }

    const filterParts: string[] = [];
    if (kind !== undefined) filterParts.push(`kind=${kind}`);
    if (layerId !== undefined) filterParts.push(`layerId=${layerId}`);
    if (name !== undefined) filterParts.push(`name${nameExact ? '==' : '~'}"${name}"`);
    if (tag !== undefined) filterParts.push(`tag="${tag}"`);
    if (hasBboxMin) filterParts.push('bbox');
    const filterDesc = filterParts.length > 0 ? ` [${filterParts.join(', ')}]` : '';

    const result: FindEntitiesResult = { matches, count: matches.length };

    return {
      document: doc,
      summary: `find_entities${filterDesc}: ${matches.length} match${matches.length === 1 ? '' : 'es'} (of ${doc.order.length} total).`,
      affected: [],
      data: result,
    };
  },
};
