import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { sub3 } from '../../lib/vec3';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { type CageState, cageState } from '../../geometry/subd/cageState';
import { bridgeLoops, holeLoop, regionLoop } from '../../geometry/subd/bridge';
import { isRefProblem, mintElementId, resolveEdges, resolveFaces } from '../../geometry/subd/elements';
import { buildTopology, connectedRegions } from '../../geometry/subd/topology';
import { withoutEntities } from '../entity/entityOps';
import { entityOfKind } from '../entity/entityOfKind';
import { dirRejection } from './codes';
import { edgeRefField, faceRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'bridge_cage_faces';
const MAX_SEGMENTS = 16;

interface Side {
  readonly loop: number[];
  readonly removed: number[];
  readonly record: Record<string, unknown> | null;
}

interface SideProblem {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

/** The boundary loop of a side given as face ids / indices (a region that will be removed) or as one edge of a hole. */
function sideOf(
  cage: SubdivisionEntity,
  faces: readonly (string | number)[] | undefined,
  edge: string | readonly [number, number] | undefined,
  label: 'A' | 'B',
): Side | SideProblem {
  const topology = buildTopology(cage.vertices.length, cage.faces);
  if (faces !== undefined) {
    const named = resolveFaces(cage, faces, `params.faces${label}`);
    if (isRefProblem(named)) return named;
    const regions = connectedRegions(topology, named.items);
    if (regions.length !== 1)
      return {
        code: 'DIR_BRIDGE_REGION',
        message: `faces${label} form ${regions.length} separate regions (need exactly one)`,
        path: `params.faces${label}`,
      };
    const loop = regionLoop(topology, regions[0] as number[]);
    if (typeof loop === 'string') return { code: 'DIR_BRIDGE_REGION', message: `faces${label}: ${loop}`, path: `params.faces${label}` };
    return { loop, removed: regions[0] as number[], record: named.byIndex ? { [`faces${label}`]: named.ids } : null };
  }
  const picked = resolveEdges(cage, [edge as string | readonly [number, number]], `params.loop${label}`, topology);
  if (isRefProblem(picked)) return picked;
  const { a, b } = topology.edges[picked.items[0] as number] as { a: number; b: number };
  const forward = topology.directed.has(`${a}>${b}`) && !topology.directed.has(`${b}>${a}`);
  const loop = holeLoop(topology, forward ? a : b, forward ? b : a);
  if (typeof loop === 'string') return { code: 'DIR_NOT_BOUNDARY', message: loop, path: `params.loop${label}` };
  return { loop, removed: [], record: picked.byIndex ? { [`loop${label}`]: picked.ids[0] } : null };
}

/** `other`'s cage appended to `state` (positions into the frame of `entity`, ids renamed on a clash); returns the index offsets. */
function appendCage(state: CageState, entity: SubdivisionEntity, other: SubdivisionEntity): { vertex: number; face: number } {
  const taken = new Set([...state.vertexIds, ...state.faceIds]);
  const offsets = { vertex: state.vertices.length, face: state.faces.length };
  const donor = cageState(other);
  for (const p of donor.vertices)
    state.vertices.push(inverseEulerXYZ(sub3(entityLocalToWorld(other, p), entity.position), entity.rotation));
  const unique = (id: string, prefix: 'v' | 'f'): string => {
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    return mintElementId(prefix, taken);
  };
  state.vertexIds.push(...donor.vertexIds.map((id) => unique(id, 'v')));
  state.faceIds.push(...donor.faceIds.map((id) => unique(id, 'f')));
  state.faces.push(...donor.faces.map((face) => face.map((v) => v + offsets.vertex)));
  state.sharp.push(...donor.sharp.map(([a, b, s]): [number, number, number] => [a + offsets.vertex, b + offsets.vertex, s]));
  state.corners.push(...donor.corners.map(({ v, s }) => ({ v: v + offsets.vertex, s })));
  return offsets;
}

/**
 * @affects modifies 1 subdivision entity (two regions removed or two holes joined by a tube of quads; with `otherId` the second cage is merged in and its entity removed); surviving elements keep their ids
 * @invariant both loops have the same vertex count; the tube is wound consistently with the cage; within one closed solid genus +1 (Euler characteristic -2); with otherId two bodies become one; the pairing minimises the summed distance before `twist`
 * @failure missing id / otherId (DIR_ENTITY_NOT_FOUND), unknown element (DIR_REF_LOST / DIR_ELEMENT_KIND), a side not given once (DIR_SELECTOR_INVALID), a side that is not one loop (DIR_BRIDGE_REGION), edge not on a boundary (DIR_NOT_BOUNDARY), different loop sizes (DIR_BRIDGE_COUNT_MISMATCH), sides sharing a vertex (DIR_BRIDGE_SAME), invalid result (DIR_CAGE_INVALID), cage cap (DIR_CAGE_TOO_LARGE), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const bridgeCageFaces = defineCommand({
  name: COMMAND,
  description:
    'Bridge two regions of a subdivision cage with a tube of quads (a handle, a tunnel, a loop): side A is `facesA` (an edge-connected face region that is ' +
    'removed; ids or indices) or `loopA` (one boundary edge of an existing hole of an open cage), likewise side B. The two boundary loops need the same ' +
    'number of vertices (DIR_BRIDGE_COUNT_MISMATCH); they are paired by the rotation that minimises the summed distance, shifted by `twist` whole vertices, and ' +
    '`segments` layers of quads are laid between them. With `otherId` side B is taken from another subdivision solid, which is merged into this one (placed ' +
    'by its own position / rotation) and removed. Within one closed solid the genus grows by 1 (a handle); with `otherId` two bodies are joined into one (no handle). Refuses a side that is not a single loop (DIR_BRIDGE_REGION), sides ' +
    'that share a vertex (DIR_BRIDGE_SAME) and different loop sizes. Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, newVertices, ' +
    'newFaces, loopSize, pairing, merged }. Next: edit_subdivision_cage to shape the tube, set_cage_crease, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    facesA: z.array(faceRefField).min(1).describe('Side A as faces (one edge-connected region, removed). Give facesA or loopA.').optional(),
    loopA: edgeRefField.describe('Side A as one boundary edge of a hole of the open cage. Give facesA or loopA.').optional(),
    facesB: z
      .array(faceRefField)
      .min(1)
      .describe('Side B as faces (one edge-connected region, removed); with otherId they belong to that solid. Give facesB or loopB.')
      .optional(),
    loopB: edgeRefField.describe('Side B as one boundary edge of a hole (of otherId when given). Give facesB or loopB.').optional(),
    otherId: z.string().describe('Id of a second subdivision solid that supplies side B; it is merged into `id` and removed.').optional(),
    twist: z
      .number()
      .int()
      .describe('Rotates the pairing of the loops by this many vertices (default 0 = the closest pairing).')
      .optional(),
    segments: z.number().int().describe(`Layers of quads along the tube, 1..${MAX_SEGMENTS} (default 1).`).optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { twist = 0, segments = 1 } = params;
    if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS)
      return reject('DIR_SELECTOR_INVALID', `segments must be an integer 1..${MAX_SEGMENTS} (got ${segments})`, ['params.segments']);
    if ((params.facesA === undefined) === (params.loopA === undefined))
      return reject('DIR_SELECTOR_INVALID', 'give exactly one of facesA and loopA', ['params.facesA']);
    if ((params.facesB === undefined) === (params.loopB === undefined))
      return reject('DIR_SELECTOR_INVALID', 'give exactly one of facesB and loopB', ['params.facesB']);
    let other: SubdivisionEntity | null = null;
    if (params.otherId !== undefined) {
      const found = params.otherId === entity.id ? 'must differ from id' : entityOfKind(doc, params.otherId, ['subdivision']);
      if (typeof found === 'string') return reject('DIR_ENTITY_NOT_FOUND', `otherId: ${found}`, ['params.otherId']);
      other = found as SubdivisionEntity;
    }
    const sideA = sideOf(entity, params.facesA, params.loopA, 'A');
    if ('code' in sideA) return reject(sideA.code, sideA.message, [sideA.path]);
    const sideB = sideOf(other ?? entity, params.facesB, params.loopB, 'B');
    if ('code' in sideB) return reject(sideB.code, sideB.message, [sideB.path]);
    if (sideA.loop.length !== sideB.loop.length)
      return reject('DIR_BRIDGE_COUNT_MISMATCH', `loop A has ${sideA.loop.length} vertices, loop B has ${sideB.loop.length}`, [
        'params.facesB',
      ]);
    if (other === null && sideA.loop.some((v) => sideB.loop.includes(v)))
      return reject('DIR_BRIDGE_SAME', 'the two sides share a vertex', ['params.facesB']);
    const state = cageState(entity);
    const offsets = other === null ? { vertex: 0, face: 0 } : appendCage(state, entity, other);
    const loopB = sideB.loop.map((v) => v + offsets.vertex);
    const removed = new Set([...sideA.removed, ...sideB.removed.map((f) => f + offsets.face)]);
    const built = bridgeLoops(state, sideA.loop, loopB, removed, twist, segments);
    const base: SubdivisionEntity = {
      ...entity,
      ...(entity.boundary === undefined && other?.boundary !== undefined ? { boundary: other.boundary } : {}),
    };
    if (other !== null) delete base.symmetry;
    const updated = finishedCage(doc, COMMAND, base, state);
    if (isCommandResult(updated)) return updated;
    const known = new Set(entity.elementIds.vertices);
    const knownFaces = new Set(entity.elementIds.faces);
    const record = { ...sideA.record, ...sideB.record };
    const next = other === null ? doc : withoutEntities(doc, new Set([other.id])).document;
    return topologyResult(
      next,
      COMMAND,
      updated,
      `${sideA.loop.length}-vertex loops bridged in ${segments} layer(s)` +
        (other === null ? '' : `; '${other.id}' merged in`) +
        `; +${built.vertices} vertices, +${built.faces} faces`,
      {
        newVertices: updated.elementIds.vertices.filter((id) => !known.has(id)),
        newFaces: updated.elementIds.faces.filter((id) => !knownFaces.has(id)),
        loopSize: sideA.loop.length,
        pairing: built.pairing,
        merged: other?.id ?? null,
      },
      Object.keys(record).length === 0 ? null : record,
    );
  },
});
