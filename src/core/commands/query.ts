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

import type { CadDocument, Entity, EntityKind } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
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
// Bbox / spatial helper functions (pure)
// ---------------------------------------------------------------------------

/** Returns the centroid of a world-space AABB. */
function bboxCentroid(b: Bounds): readonly [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** 3D euclidean distance squared between two points. */
function distSq(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Returns true when AABB `b` is fully inside `[qMin, qMax]`. */
function insideAabb(
  b: Bounds,
  qMin: readonly [number, number, number],
  qMax: readonly [number, number, number],
): boolean {
  return (
    b.min[0] >= qMin[0] &&
    b.max[0] <= qMax[0] &&
    b.min[1] >= qMin[1] &&
    b.max[1] <= qMax[1] &&
    b.min[2] >= qMin[2] &&
    b.max[2] <= qMax[2]
  );
}

/** Returns true when AABB `b` intersects `[qMin, qMax]` (at least one axis overlaps). */
function overlapsAabb(
  b: Bounds,
  qMin: readonly [number, number, number],
  qMax: readonly [number, number, number],
): boolean {
  return (
    b.max[0] >= qMin[0] &&
    b.min[0] <= qMax[0] &&
    b.max[1] >= qMin[1] &&
    b.min[1] <= qMax[1] &&
    b.max[2] >= qMin[2] &&
    b.min[2] <= qMax[2]
  );
}

/** Returns true when the entity's world-space AABB overlaps the given bbox filter. */
function overlapsBbox(
  e: Entity,
  bboxMin: readonly [number, number, number],
  bboxMax: readonly [number, number, number],
): boolean {
  return overlapsAabb(entityBounds(e), bboxMin, bboxMax);
}

const POINT_3D = z.tuple([z.number(), z.number(), z.number()]);

const vec3Exact = (description: string): typeof POINT_3D => POINT_3D.describe(description);

// ---------------------------------------------------------------------------
// find_entities
// ---------------------------------------------------------------------------

/**
 * Resolve the touching-id filter: compute the bbox of the reference entity and
 * return it, or null when the id is absent.
 */
function resolveTouchingBounds(doc: CadDocument, touchingId: string): Bounds | null {
  const ref = doc.entities[touchingId];
  if (!ref) return null;
  return entityBounds(ref);
}

/**
 * @command find_entities
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data is FindEntitiesResult; document === input doc
 * @failure invalid bbox (bboxMin without bboxMax or vice-versa) -> no-op, affected:[]
 * @failure nearPoint.radius <= 0 -> no-op, affected:[]
 * @failure nearPoint.point not a 3-array of finite numbers -> no-op, affected:[]
 * @failure insideBBox/overlapsBBox min > max on any axis -> no-op, affected:[]
 * @failure touchingId missing from document -> no-op, affected:[]
 */
export const findEntities = defineCommand({
  name: 'find_entities',
  annotations: { readOnly: true },
  description:
    'Filter entities by any combination of: kind, layerId, name (exact or substring), tag (exact), ' +
    'bboxMin/bboxMax (legacy overlap), nearPoint (centroid within radius), insideBBox (AABB fully inside), ' +
    'overlapsBBox (AABB intersects), touchingId (bbox touches another entity), nameFuzzy (case-insensitive ' +
    'substring on name), tagFuzzy (case-insensitive substring on any tag). All supplied filters are AND-ed. ' +
    'Returns matched entity descriptors (id, kind, layerId, name, tags) in result.data. Does NOT modify the document.',
  params: z.object({
    kind: z
      .enum([
        'box',
        'cylinder',
        'sphere',
        'extrusion',
        'mesh',
        'cone',
        'torus',
        'wedge',
        'pyramid',
        'line',
        'polyline',
        'arc',
        'circle',
        'rectangle',
        'point',
        'ellipse',
        'spline',
      ])
      .optional()
      .describe(
        'Filter by entity kind. One of: "box", "cylinder", "sphere", "extrusion", "mesh", ' +
          '"cone", "torus", "wedge", "pyramid", "line", "polyline", "arc", "circle", "rectangle", ' +
          '"point", "ellipse", "spline". Omit to match all kinds.',
      ),
    layerId: z
      .string()
      .optional()
      .describe(
        'Filter by layer id. Only entities assigned to this layer are returned. Omit to match all layers.',
      ),
    name: z
      .string()
      .optional()
      .describe(
        'Filter by entity name. By default performs a case-insensitive substring match. ' +
          'Set nameExact:true for a case-sensitive exact match. Omit to match all names.',
      ),
    nameExact: z
      .boolean()
      .optional()
      .describe(
        'When true, the name filter requires an exact case-sensitive match instead of a substring match. Default: false.',
      ),
    tag: z
      .string()
      .optional()
      .describe(
        'Filter to entities that have this exact tag string in their tags array. Omit to match all entities regardless of tags.',
      ),
    bboxMin: vec3Exact(
      'World-space minimum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMax. ' +
        'Only entities whose world-space AABB overlaps this box are returned.',
    ).optional(),
    bboxMax: vec3Exact(
      'World-space maximum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMin. ' +
        'Only entities whose world-space AABB overlaps this box are returned.',
    ).optional(),
    nearPoint: z
      .object({
        point: vec3Exact('World-space origin [x, y, z] of the proximity search.'),
        radius: z.number().describe('Maximum distance from point to entity centroid. Must be > 0.'),
      })
      .optional()
      .describe(
        'Spatial filter: return only entities whose bbox centroid is within `radius` units (3D euclidean) of `point`. ' +
          'Provide as { "point": [x, y, z], "radius": number }. radius must be > 0.',
      ),
    insideBBox: z
      .tuple([POINT_3D, POINT_3D])
      .optional()
      .describe(
        'Spatial filter: return only entities whose world-space AABB is FULLY inside the given box. ' +
          'Provide as [[minX,minY,minZ],[maxX,maxY,maxZ]]. min must be <= max on every axis.',
      ),
    overlapsBBox: z
      .tuple([POINT_3D, POINT_3D])
      .optional()
      .describe(
        'Spatial filter: return only entities whose world-space AABB INTERSECTS the given box. ' +
          'Provide as [[minX,minY,minZ],[maxX,maxY,maxZ]]. min must be <= max on every axis.',
      ),
    touchingId: z
      .string()
      .optional()
      .describe(
        'Spatial filter: return entities whose world-space AABB overlaps the AABB of the entity with this id. ' +
          'The reference entity itself is excluded from results. The id must exist in the document.',
      ),
    nameFuzzy: z
      .string()
      .optional()
      .describe(
        'Fuzzy name filter: case-insensitive substring match on entity name. ' +
          'Matches any entity whose name contains this string. Omit to skip this filter.',
      ),
    tagFuzzy: z
      .string()
      .optional()
      .describe(
        "Fuzzy tag filter: case-insensitive substring match on any tag in the entity's tags array. " +
          'Matches if ANY tag contains this substring. Omit to skip this filter.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const {
      kind,
      layerId,
      name,
      nameExact = false,
      tag,
      bboxMin,
      bboxMax,
      nearPoint,
      insideBBox,
      overlapsBBox,
      touchingId,
      nameFuzzy,
      tagFuzzy,
    } = params;

    // --- Validate legacy bbox: must supply both or neither ---
    const hasBboxMin = bboxMin !== undefined;
    const hasBboxMax = bboxMax !== undefined;
    if (hasBboxMin !== hasBboxMax) {
      return {
        document: doc,
        summary: 'find_entities: bboxMin and bboxMax must both be provided or both omitted.',
        affected: [],
      };
    }

    // --- Validate nearPoint ---
    if (nearPoint !== undefined) {
      if (nearPoint.radius <= 0) {
        return {
          document: doc,
          summary: 'find_entities: nearPoint.radius must be a finite number > 0.',
          affected: [],
        };
      }
    }

    // --- Validate insideBBox ---
    if (insideBBox !== undefined) {
      const [qMin, qMax] = insideBBox;
      if (qMin[0] > qMax[0] || qMin[1] > qMax[1] || qMin[2] > qMax[2]) {
        return {
          document: doc,
          summary: 'find_entities: insideBBox min must be <= max on every axis.',
          affected: [],
        };
      }
    }

    // --- Validate overlapsBBox ---
    if (overlapsBBox !== undefined) {
      const [qMin, qMax] = overlapsBBox;
      if (qMin[0] > qMax[0] || qMin[1] > qMax[1] || qMin[2] > qMax[2]) {
        return {
          document: doc,
          summary: 'find_entities: overlapsBBox min must be <= max on every axis.',
          affected: [],
        };
      }
    }

    // --- Validate touchingId ---
    let touchingBounds: Bounds | null = null;
    if (touchingId !== undefined) {
      touchingBounds = resolveTouchingBounds(doc, touchingId);
      if (touchingBounds === null) {
        return {
          document: doc,
          summary: `find_entities: touchingId "${touchingId}" does not exist in the document.`,
          affected: [],
        };
      }
    }

    // --- Precompute typed spatial params ---
    const npPoint = nearPoint !== undefined ? nearPoint.point : null;
    const npRadiusSq = nearPoint !== undefined ? nearPoint.radius * nearPoint.radius : 0;

    const insideMin = insideBBox !== undefined ? insideBBox[0] : null;
    const insideMax = insideBBox !== undefined ? insideBBox[1] : null;

    const overlapMin = overlapsBBox !== undefined ? overlapsBBox[0] : null;
    const overlapMax = overlapsBBox !== undefined ? overlapsBBox[1] : null;

    const nameFuzzyLc = nameFuzzy !== undefined ? nameFuzzy.toLowerCase() : null;
    const tagFuzzyLc = tagFuzzy !== undefined ? tagFuzzy.toLowerCase() : null;

    // --- Main filter loop ---
    const matches: EntityMatch[] = [];

    for (const id of doc.order) {
      const e = doc.entities[id];
      if (!e) continue;

      // kind filter
      if (kind !== undefined && e.kind !== kind) continue;

      // layerId filter
      if (layerId !== undefined && e.layerId !== layerId) continue;

      // name filter (exact / substring)
      if (name !== undefined) {
        const entityName = e.name;
        if (entityName === undefined) continue;
        if (nameExact) {
          if (entityName !== name) continue;
        } else {
          if (!entityName.toLowerCase().includes(name.toLowerCase())) continue;
        }
      }

      // tag filter (exact)
      if (tag !== undefined) {
        const entityTags = e.tags;
        if (!entityTags || !entityTags.includes(tag)) continue;
      }

      // legacy bbox filter (overlap)
      if (hasBboxMin && bboxMin !== undefined && bboxMax !== undefined) {
        if (!overlapsBbox(e, bboxMin, bboxMax)) continue;
      }

      // nearPoint filter
      if (npPoint !== null) {
        const b = entityBounds(e);
        const centroid = bboxCentroid(b);
        if (distSq(centroid, npPoint) > npRadiusSq) continue;
      }

      // insideBBox filter
      if (insideMin !== null && insideMax !== null) {
        const b = entityBounds(e);
        if (!insideAabb(b, insideMin, insideMax)) continue;
      }

      // overlapsBBox filter
      if (overlapMin !== null && overlapMax !== null) {
        const b = entityBounds(e);
        if (!overlapsAabb(b, overlapMin, overlapMax)) continue;
      }

      // touchingId filter (skip the reference entity itself)
      if (touchingBounds !== null && touchingId !== undefined) {
        if (e.id === touchingId) continue;
        const b = entityBounds(e);
        if (!overlapsAabb(b, touchingBounds.min, touchingBounds.max)) continue;
      }

      // nameFuzzy filter
      if (nameFuzzyLc !== null) {
        const entityName = e.name;
        if (entityName === undefined || !entityName.toLowerCase().includes(nameFuzzyLc)) continue;
      }

      // tagFuzzy filter
      if (tagFuzzyLc !== null) {
        const entityTags = e.tags;
        if (!entityTags) continue;
        const anyMatch = entityTags.some((t) => t.toLowerCase().includes(tagFuzzyLc));
        if (!anyMatch) continue;
      }

      matches.push({
        id: e.id,
        kind: e.kind,
        layerId: e.layerId,
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.tags !== undefined ? { tags: e.tags } : {}),
      });
    }

    // --- Build summary ---
    const filterParts: string[] = [];
    if (kind !== undefined) filterParts.push(`kind=${kind}`);
    if (layerId !== undefined) filterParts.push(`layerId=${layerId}`);
    if (name !== undefined) filterParts.push(`name${nameExact ? '==' : '~'}"${name}"`);
    if (tag !== undefined) filterParts.push(`tag="${tag}"`);
    if (hasBboxMin) filterParts.push('bbox');
    if (nearPoint !== undefined) filterParts.push(`nearPoint(r=${nearPoint.radius})`);
    if (insideBBox !== undefined) filterParts.push('insideBBox');
    if (overlapsBBox !== undefined) filterParts.push('overlapsBBox');
    if (touchingId !== undefined) filterParts.push(`touching="${touchingId}"`);
    if (nameFuzzy !== undefined) filterParts.push(`nameFuzzy~"${nameFuzzy}"`);
    if (tagFuzzy !== undefined) filterParts.push(`tagFuzzy~"${tagFuzzy}"`);
    const filterDesc = filterParts.length > 0 ? ` [${filterParts.join(', ')}]` : '';

    const result: FindEntitiesResult = { matches, count: matches.length };

    return {
      document: doc,
      summary: `find_entities${filterDesc}: ${matches.length} match${matches.length === 1 ? '' : 'es'} (of ${doc.order.length} total).`,
      affected: [],
      data: result,
    };
  },
});
