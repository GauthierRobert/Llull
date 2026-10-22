/** Helpers shared by the subdivision cage commands: size caps, cage `data`, element-reference schemas, entity lookup. */

import { z } from '../schema';
import { roundTo } from '../../lib/compactNumber';
import { map3 } from '../../lib/vec3';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { type Cage, MAX_SUBDIVISION_LEVELS } from '../../geometry/subdivision';
import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import { entityOfKind } from '../entity/entityOfKind';
import type { CommandResult } from '../types';
import { dirRejection } from './codes';

/** Largest cage accepted (vertices); the surface grows x4 per level. */
export const MAX_CAGE_VERTICES = 2000;

export const levelsField = z
  .number()
  .int()
  .describe(
    `Subdivision levels 0..${MAX_SUBDIVISION_LEVELS} (0 = the faceted cage itself; 2-3 is smooth; ` +
      'each level quadruples the face count).',
  );

export const vertexRefField = z
  .union([z.string(), z.number().int()])
  .describe('A cage vertex: element id ("v-1.7", stable across topology edits) or current index.');
export const faceRefField = z
  .union([z.string(), z.number().int()])
  .describe('A cage face: element id ("f-1.2", stable across topology edits) or current index.');
export const edgeRefField = z
  .union([z.string(), z.tuple([z.number().int(), z.number().int()])])
  .describe('A cage edge: id "e:<vertexIdA>|<vertexIdB>" (stable) or a [vertexIndex, vertexIndex] pair.');

export const cageText = (cage: Cage, levels: number): string =>
  `${cage.vertices.length}-vertex / ${cage.faces.length}-face cage, ${levels} level(s)` +
  (cage.creases.length > 0 ? `, ${cage.creases.length} crease(s)` : '') +
  ((cage.edgeSharpness?.length ?? 0) > 0 ? `, ${cage.edgeSharpness?.length} semi-sharp edge(s)` : '');

/** Why `levels` / the cage size are out of range (null when fine), as a stable code with its message. */
export function sizeProblem(cage: Cage, levels: number): { code: 'DIR_LEVELS_RANGE' | 'DIR_CAGE_TOO_LARGE'; message: string } | null {
  if (!Number.isInteger(levels) || levels < 0 || levels > MAX_SUBDIVISION_LEVELS)
    return { code: 'DIR_LEVELS_RANGE', message: `levels must be an integer 0..${MAX_SUBDIVISION_LEVELS} (got ${levels})` };
  if (cage.vertices.length > MAX_CAGE_VERTICES)
    return { code: 'DIR_CAGE_TOO_LARGE', message: `the cage has ${cage.vertices.length} vertices (max ${MAX_CAGE_VERTICES})` };
  return null;
}

/** World coordinates of a cage point, rounded to 1e-6. */
export function worldOf(p: Vec3, entity: { position: Vec3; rotation: Vec3 }): Vec3 {
  return map3(entityLocalToWorld(entity, p), (value) => roundTo(value, 6));
}

/** `data` of the cage commands: counts, the cage vertices in world coordinates and the element ids (parallel to vertices / faces). */
export function cageData(entity: Pick<SubdivisionEntity, 'vertices' | 'faces' | 'position' | 'rotation' | 'elementIds'>): {
  vertexCount: number;
  faceCount: number;
  vertices: Vec3[];
  vertexIds: string[];
  faceIds: string[];
} {
  return {
    vertexCount: entity.vertices.length,
    faceCount: entity.faces.length,
    vertices: entity.vertices.map((p) => worldOf(p, entity)),
    vertexIds: [...entity.elementIds.vertices],
    faceIds: [...entity.elementIds.faces],
  };
}

/** The subdivision entity `id`, or the coded refusal of `command`. */
export function subdivisionOf(doc: CadDocument, id: string, command: string): SubdivisionEntity | CommandResult {
  const entity = entityOfKind(doc, id, ['subdivision']);
  if (typeof entity === 'string') return dirRejection(doc, command, 'DIR_ENTITY_NOT_FOUND', entity, [id], ['params.id']);
  return entity;
}

export const isEntity = (value: SubdivisionEntity | CommandResult): value is SubdivisionEntity => 'kind' in value;
