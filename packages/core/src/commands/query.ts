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

import type { EntityKind } from '../model/types';
import { SHAPE2D_KINDS, SOLID_KINDS } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, vec3, z } from './schema';
import { noop, report } from './noop';
import { boundsCenter, boundsOverlap, entityBoundsInDoc } from './sceneBounds';
import type { Bounds } from './sceneTypes';
import { distanceSq3 } from '../lib/vec3';

/** Every entity kind a `kind` filter can name. */
const FILTERABLE_KINDS = [...SOLID_KINDS, ...SHAPE2D_KINDS, 'instance'] as const;

/** A compact descriptor of one matched entity, safe to return in `data`. */
interface EntityMatch {
  id: string;
  kind: EntityKind;
  layerId: string;
  name?: string;
  tags?: readonly string[];
}

interface FindEntitiesResult {
  matches: EntityMatch[];
  count: number;
}

type Corner = readonly [number, number, number];

const axes = [0, 1, 2] as const;

/** True when AABB `b` is fully inside `[qMin, qMax]`. */
const insideAabb = (b: Bounds, qMin: Corner, qMax: Corner): boolean =>
  axes.every((i) => b.min[i] >= qMin[i] && b.max[i] <= qMax[i]);

const isInverted = (min: Corner, max: Corner): boolean => axes.some((i) => min[i] > max[i]);

const POINT_3D = z.tuple([z.number(), z.number(), z.number()]);

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
      .enum(FILTERABLE_KINDS)
      .optional()
      .describe(
        `Filter by entity kind. One of: ${FILTERABLE_KINDS.map((kind) => `"${kind}"`).join(', ')}. ` +
          'Omit to match all kinds.',
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
    bboxMin: vec3(
      'World-space minimum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMax. ' +
        'Only entities whose world-space AABB overlaps this box are returned.',
    ).optional(),
    bboxMax: vec3(
      'World-space maximum corner [x, y, z] of a bounding box filter. Must be provided together with bboxMin. ' +
        'Only entities whose world-space AABB overlaps this box are returned.',
    ).optional(),
    nearPoint: z
      .object({
        point: vec3('World-space origin [x, y, z] of the proximity search.'),
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

    const fail = (summary: string): CommandResult => noop(doc, summary);
    if ((bboxMin === undefined) !== (bboxMax === undefined))
      return fail('find_entities: bboxMin and bboxMax must both be provided or both omitted.');
    if (nearPoint !== undefined && nearPoint.radius <= 0)
      return fail('find_entities: nearPoint.radius must be a finite number > 0.');
    if (insideBBox !== undefined && isInverted(insideBBox[0], insideBBox[1]))
      return fail('find_entities: insideBBox min must be <= max on every axis.');
    if (overlapsBBox !== undefined && isInverted(overlapsBBox[0], overlapsBBox[1]))
      return fail('find_entities: overlapsBBox min must be <= max on every axis.');
    const touchingRef = touchingId !== undefined ? doc.entities[touchingId] : undefined;
    if (touchingId !== undefined && !touchingRef)
      return fail(`find_entities: touchingId "${touchingId}" does not exist in the document.`);
    const touchingBounds = touchingRef ? entityBoundsInDoc(doc, touchingRef) : null;
    const nearRadiusSq = nearPoint ? nearPoint.radius * nearPoint.radius : 0;
    const nameLc = name?.toLowerCase();
    const nameFuzzyLc = nameFuzzy?.toLowerCase();
    const tagFuzzyLc = tagFuzzy?.toLowerCase();

    const matches: EntityMatch[] = [];
    for (const id of doc.order) {
      const e = doc.entities[id];
      if (!e) continue;
      if (kind !== undefined && e.kind !== kind) continue;
      if (layerId !== undefined && e.layerId !== layerId) continue;
      if (name !== undefined) {
        if (e.name === undefined) continue;
        if (nameExact ? e.name !== name : !e.name.toLowerCase().includes(nameLc ?? '')) continue;
      }
      if (tag !== undefined && !e.tags?.includes(tag)) continue;
      if (nameFuzzyLc !== undefined && !e.name?.toLowerCase().includes(nameFuzzyLc)) continue;
      if (tagFuzzyLc !== undefined && !e.tags?.some((t) => t.toLowerCase().includes(tagFuzzyLc)))
        continue;
      if (touchingId !== undefined && e.id === touchingId) continue;

      const needsBounds = bboxMin || nearPoint || insideBBox || overlapsBBox || touchingBounds;
      if (needsBounds) {
        const b = entityBoundsInDoc(doc, e);
        if (bboxMin && bboxMax && !boundsOverlap(b, { min: bboxMin, max: bboxMax })) continue;
        if (nearPoint && distanceSq3(boundsCenter(b), nearPoint.point) > nearRadiusSq) continue;
        if (insideBBox && !insideAabb(b, insideBBox[0], insideBBox[1])) continue;
        if (overlapsBBox && !boundsOverlap(b, { min: overlapsBBox[0], max: overlapsBBox[1] }))
          continue;
        if (touchingBounds && !boundsOverlap(b, touchingBounds)) continue;
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
    if (bboxMin !== undefined) filterParts.push('bbox');
    if (nearPoint !== undefined) filterParts.push(`nearPoint(r=${nearPoint.radius})`);
    if (insideBBox !== undefined) filterParts.push('insideBBox');
    if (overlapsBBox !== undefined) filterParts.push('overlapsBBox');
    if (touchingId !== undefined) filterParts.push(`touching="${touchingId}"`);
    if (nameFuzzy !== undefined) filterParts.push(`nameFuzzy~"${nameFuzzy}"`);
    if (tagFuzzy !== undefined) filterParts.push(`tagFuzzy~"${tagFuzzy}"`);
    const filterDesc = filterParts.length > 0 ? ` [${filterParts.join(', ')}]` : '';

    const result: FindEntitiesResult = { matches, count: matches.length };

    return report(
      doc,
      `find_entities${filterDesc}: ${matches.length} match${matches.length === 1 ? '' : 'es'} (of ${doc.order.length} total).`,
      result,
    );
  },
});
