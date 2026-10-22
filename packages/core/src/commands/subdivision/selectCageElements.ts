import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { report } from '../noop';
import { distance3, dot3, len3, normalize3OrZero, sub3 } from '../../lib/vec3';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { edgeIdOf, isRefProblem, resolveEdges } from '../../geometry/subd/elements';
import { edgeLoop, isRingProblem, walkRing } from '../../geometry/subd/loops';
import { nearestCageElements } from '../../geometry/subd/pick';
import { newellVector } from '../../geometry/subd/topology';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { worldVertices } from './cageSelection';
import { edgeRefField, isEntity, subdivisionOf } from './shared';

const COMMAND = 'select_cage_elements';
const MAX_LISTED = 5000;

interface Found {
  vertices: Set<number>;
  edges: Set<number>;
  faces: Set<number>;
  how: string;
}

const inside = (world: readonly Vec3[], test: (p: Vec3) => boolean): Set<number> => new Set(world.flatMap((p, v) => (test(p) ? [v] : [])));

/**
 * @affects none (read-only); data = { vertices, edges, faces } element ids (loops ordered), vertexIndices, faceIndices
 * @invariant ids are the stable element ids accepted by every cage command; lists are capped at 5000 (`truncated`)
 * @failure missing id (DIR_ENTITY_NOT_FOUND), not exactly one selector (DIR_SELECTOR_INVALID), unknown edge (DIR_REF_LOST), strip meets an n-gon (DIR_LOOP_NOT_QUAD)
 */
export const selectCageElements = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Find cage elements of a subdivision solid and return their stable ids for the editing commands. Give exactly ONE selector: ' +
    '`nearest` (world point -> nearest vertex, edge or face per `kind`, default vertex); `loopFrom` (edge: the edge loop through it, ' +
    'ordered, continuing straight through valence-4 vertices); `ringFrom` (edge: the quad strip across it, the edges a loop cut would ' +
    'split plus the strip faces); `region` (world box: vertices inside, edges and faces entirely inside); `within` ({ point, radius } ' +
    'world sphere, same rule); `faces` ({ normal, within }: faces whose outward normal is within the cone, dot(n, normal) >= 1 - within). ' +
    '`grow` widens the result by n rings of neighbours; `kind` keeps only vertices, edges or faces. Returns data { vertices, edges, ' +
    'faces } (ids), vertexIndices, faceIndices. Next: extrude_cage_faces, inset_cage_faces, loop_cut_cage, set_cage_crease, edit_subdivision_cage.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    nearest: vec3('World point; selects the cage element of `kind` closest to it.').optional(),
    loopFrom: edgeRefField.describe('Edge whose edge loop is selected (id or [a, b]).').optional(),
    ringFrom: edgeRefField.describe('Edge whose quad strip (face ring) is selected (id or [a, b]).').optional(),
    region: z
      .object({ min: vec3('World-space minimum corner.'), max: vec3('World-space maximum corner.') })
      .describe('World box: elements entirely inside it.')
      .optional(),
    within: z
      .object({ point: vec3('World-space centre.'), radius: z.number().positive().describe('Sphere radius, document units.') })
      .describe('World sphere: elements entirely inside it.')
      .optional(),
    faces: z
      .object({
        normal: vec3('World direction (any non-zero length) the faces should face.'),
        within: z
          .number()
          .min(0)
          .max(2)
          .describe('Cone width as 1 - cos(angle): 0 exact, 0.05 about 18 degrees, 1 a half space. Default 0.05.')
          .optional(),
      })
      .describe('Faces whose outward normal lies in a cone around `normal`.')
      .optional(),
    grow: z.number().int().min(0).max(8).describe('Rings of neighbours added around the result (default 0).').optional(),
    kind: z
      .enum(['vertex', 'edge', 'face'])
      .describe('For `nearest`: which element to find (default vertex). Otherwise: keep only this kind in the result.')
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const selectors = [params.nearest, params.loopFrom, params.ringFrom, params.region, params.within, params.faces].filter(
      (s) => s !== undefined,
    );
    if (selectors.length !== 1) return reject('DIR_SELECTOR_INVALID', `give exactly one selector (got ${selectors.length})`);
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const world = worldVertices(entity);
    const found: Found = { vertices: new Set(), edges: new Set(), faces: new Set(), how: '' };
    const wholeInside = (test: (p: Vec3) => boolean): void => {
      found.vertices = inside(world, test);
      topology.edges.forEach(({ a, b }, e) => {
        if (found.vertices.has(a) && found.vertices.has(b)) found.edges.add(e);
      });
      entity.faces.forEach((face, f) => {
        if (face.every((v) => found.vertices.has(v))) found.faces.add(f);
      });
    };
    const ordered: { edges: number[] } = { edges: [] };
    if (params.nearest !== undefined) {
      const nearest = nearestCageElements(entity, inverseEulerXYZ(sub3(params.nearest, entity.position), entity.rotation));
      const kind = params.kind ?? 'vertex';
      if (kind === 'vertex' && nearest.vertex) found.vertices.add(nearest.vertex.index);
      if (kind === 'edge' && nearest.edge) found.edges.add(nearest.edge.index);
      if (kind === 'face' && nearest.face) found.faces.add(nearest.face.index);
      found.how = `nearest ${kind}`;
    } else if (params.loopFrom !== undefined || params.ringFrom !== undefined) {
      const ref = (params.loopFrom ?? params.ringFrom) as NonNullable<typeof params.loopFrom>;
      const start = resolveEdges(entity, [ref], params.loopFrom !== undefined ? 'params.loopFrom' : 'params.ringFrom', topology);
      if (isRefProblem(start)) return reject(start.code, start.message, [start.path]);
      const edge = topology.edges[start.items[0] as number] as { a: number; b: number };
      if (params.loopFrom !== undefined) {
        const chain = edgeLoop(topology, edge.a, edge.b);
        ordered.edges = chain.map(([a, b]) => topology.edgeIndex.get(edgeKey(a, b)) as number);
        found.how = 'edge loop';
      } else {
        const ring = walkRing(topology, edge.a, edge.b);
        if (isRingProblem(ring)) return reject('DIR_LOOP_NOT_QUAD', ring.message, ['params.ringFrom']);
        ordered.edges = ring.edges.map(([a, b]) => topology.edgeIndex.get(edgeKey(a, b)) as number);
        ring.faces.forEach((f) => found.faces.add(f));
        found.how = 'face ring';
      }
      for (const e of ordered.edges) {
        found.edges.add(e);
        found.vertices.add((topology.edges[e] as { a: number }).a);
        found.vertices.add((topology.edges[e] as { b: number }).b);
      }
    } else if (params.region !== undefined) {
      const { min, max } = params.region;
      wholeInside((p) => p.every((value, axis) => value >= (min[axis] as number) - 1e-9 && value <= (max[axis] as number) + 1e-9));
      found.how = 'region';
    } else if (params.within !== undefined) {
      const { point, radius } = params.within;
      wholeInside((p) => distance3(p, point) <= radius + 1e-9);
      found.how = 'sphere';
    } else if (params.faces !== undefined) {
      const wanted = normalize3OrZero(params.faces.normal);
      if (len3(params.faces.normal) < 1e-12) return reject('DIR_SELECTOR_INVALID', 'faces.normal has zero length', ['params.faces.normal']);
      const origin = entityLocalToWorld(entity, [0, 0, 0]);
      const cone = params.faces.within ?? 0.05;
      entity.faces.forEach((face, f) => {
        const local = newellVector(entity.vertices, face);
        if (len3(local) < 1e-12) return;
        const worldNormal = normalize3OrZero(sub3(entityLocalToWorld(entity, local), origin));
        if (dot3(worldNormal, wanted) >= 1 - cone - 1e-9) found.faces.add(f);
      });
      for (const f of found.faces) for (const v of entity.faces[f] as ReadonlyArray<number>) found.vertices.add(v);
      topology.edges.forEach(({ a, b }, e) => {
        if (found.vertices.has(a) && found.vertices.has(b) && topology.edges[e]?.faces.some((f) => found.faces.has(f))) found.edges.add(e);
      });
      found.how = 'face normal cone';
    }
    for (let ring = 0; ring < (params.grow ?? 0); ring++) grow(entity, topology, found);
    return answer(doc, entity, topology, found, ordered.edges, params.kind, params.nearest === undefined);
  },
});

/** One ring of neighbours around the found elements. */
function grow(entity: SubdivisionEntity, topology: ReturnType<typeof buildTopology>, found: Found): void {
  const touched = new Set(found.vertices);
  for (const e of found.edges) {
    touched.add((topology.edges[e] as { a: number }).a);
    touched.add((topology.edges[e] as { b: number }).b);
  }
  for (const f of found.faces) for (const v of entity.faces[f] as ReadonlyArray<number>) touched.add(v);
  for (const v of [...touched]) {
    for (const e of topology.vertexEdges[v] as number[]) {
      const edge = topology.edges[e] as { a: number; b: number };
      found.edges.add(e);
      touched.add(edge.a);
      touched.add(edge.b);
    }
    for (const f of topology.vertexFaces[v] as number[]) found.faces.add(f);
  }
  for (const v of touched) found.vertices.add(v);
}

function answer(
  doc: CadDocument,
  entity: SubdivisionEntity,
  topology: ReturnType<typeof buildTopology>,
  found: Found,
  orderedEdges: readonly number[],
  kind: 'vertex' | 'edge' | 'face' | undefined,
  filter: boolean,
): CommandResult {
  const keep = (what: 'vertex' | 'edge' | 'face'): boolean => !filter || kind === undefined || kind === what;
  const vertices = keep('vertex') ? [...found.vertices].sort((a, b) => a - b) : [];
  const faces = keep('face') ? [...found.faces].sort((a, b) => a - b) : [];
  const edgeOrder = orderedEdges.length > 0 ? orderedEdges.filter((e) => found.edges.has(e)) : [...found.edges].sort((a, b) => a - b);
  const edges = keep('edge') ? [...new Set([...edgeOrder, ...found.edges])] : [];
  const cut = <T>(list: T[]): T[] => list.slice(0, MAX_LISTED);
  const edgeIds = edges.map((e) => {
    const { a, b } = topology.edges[e] as { a: number; b: number };
    return edgeIdOf(entity.elementIds, a, b);
  });
  const data = {
    vertices: cut(vertices.map((v) => entity.elementIds.vertices[v] as string)),
    edges: cut(edgeIds),
    faces: cut(faces.map((f) => entity.elementIds.faces[f] as string)),
    vertexIndices: cut(vertices),
    faceIndices: cut(faces),
    truncated: Math.max(vertices.length, edges.length, faces.length) > MAX_LISTED,
  };
  return report(
    doc,
    `${COMMAND}: '${entity.id}' — ${found.how}: ${vertices.length} vertex(es), ${edges.length} edge(s), ${faces.length} face(s).`,
    data,
  );
}
