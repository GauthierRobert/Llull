/** morph_bodies — the shape a fraction t of the way between two entities of the same structure (01 DEF M5, FR-DEF-19). */

import type { CadDocument, Entity, MeshData, MeshSolidEntity, NurbsCurveEntity, NurbsSurfaceEntity, Vec3 } from '../../model/types';
import { worldCurve, worldMeshPositions, worldSurface } from '../../geometry/deform/worldNurbs';
import { nextId } from '../../lib/id';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { defineCommand, z } from '../schema';
import { newEntity } from '../entity/newEntity';
import { withEntities } from '../entity/entityOps';
import { changed } from '../noop';
import type { CommandResult } from '../types';
import { defRejection } from './codes';

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixPoint = (a: Vec3, b: Vec3, t: number): Vec3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

const sameNumbers = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
  a.length === b.length && a.every((value, k) => Math.abs(value - (b[k] as number)) <= 1e-12 * (1 + Math.abs(value)));

/** Why two curves cannot be morphed, or the morph at `t`. */
function morphCurves(a: NurbsCurveData, b: NurbsCurveData, t: number): NurbsCurveData | string {
  if (a.degree !== b.degree || a.poles.length !== b.poles.length)
    return `the curves differ in degree (${a.degree} / ${b.degree}) or pole count (${a.poles.length} / ${b.poles.length})`;
  if (!sameNumbers(a.knots, b.knots) || !sameNumbers(a.multiplicities, b.multiplicities)) return 'the curves have different knot vectors';
  if ((a.weights === undefined) !== (b.weights === undefined)) return 'one curve is rational and the other is not';
  const weights =
    a.weights === undefined || b.weights === undefined ? undefined : a.weights.map((w, k) => mix(w, b.weights?.[k] as number, t));
  return { ...a, poles: a.poles.map((pole, k) => mixPoint(pole, b.poles[k] as Vec3, t)), ...(weights === undefined ? {} : { weights }) };
}

function morphSurfaces(a: NurbsSurfaceData, b: NurbsSurfaceData, t: number): NurbsSurfaceData | string {
  const [rows, columns] = [a.poles.length, a.poles[0]?.length ?? 0];
  if (a.degreeU !== b.degreeU || a.degreeV !== b.degreeV || rows !== b.poles.length || columns !== (b.poles[0]?.length ?? 0))
    return 'the sheets differ in degree or pole grid';
  if (
    !sameNumbers(a.knotsU, b.knotsU) ||
    !sameNumbers(a.knotsV, b.knotsV) ||
    !sameNumbers(a.multiplicitiesU, b.multiplicitiesU) ||
    !sameNumbers(a.multiplicitiesV, b.multiplicitiesV)
  )
    return 'the sheets have different knot vectors';
  if ((a.weights === undefined) !== (b.weights === undefined)) return 'one sheet is rational and the other is not';
  const weights =
    a.weights === undefined || b.weights === undefined
      ? undefined
      : a.weights.map((row, i) => row.map((w, j) => mix(w, (b.weights?.[i] as number[])[j] as number, t)));
  return {
    ...a,
    poles: a.poles.map((row, i) => row.map((pole, j) => mixPoint(pole, (b.poles[i] as Vec3[])[j] as Vec3, t))),
    ...(weights === undefined ? {} : { weights }),
  };
}

function morphMeshes(from: MeshSolidEntity, to: MeshSolidEntity, t: number): MeshData | string {
  const [a, b] = [
    { ...from.mesh, positions: worldMeshPositions(from) },
    { ...to.mesh, positions: worldMeshPositions(to) },
  ];
  if (
    a.positions.length !== b.positions.length ||
    a.indices.length !== b.indices.length ||
    a.indices.some((index, k) => index !== b.indices[k])
  )
    return 'the meshes differ in vertex count or connectivity';
  return { positions: a.positions.map((value, k) => mix(value, b.positions[k] as number, t)), indices: a.indices };
}

/**
 * @affects adds one entity of the same kind as both inputs (a nurbs_curve, nurbs_surface or mesh); the inputs are kept
 * @invariant t = 0 gives the first input and t = 1 the second; poles (or vertices) are interpolated linearly in world coordinates, knots, degrees and connectivity must match
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; different kinds, degrees, knots, pole grids, rationality or connectivity -> DEF_MORPH_INCOMPATIBLE; t outside 0..1 -> DEF_MORPH_PARAMETER
 */
export const morphBodies = defineCommand({
  name: 'morph_bodies',
  annotations: { readsMeshTriangles: true },
  description:
    'Create the shape a fraction t of the way between two entities with the same structure: two nurbs_curve entities with the same degree, knot vector and pole count, ' +
    'two nurbs_surface sheets with the same degrees, knot vectors and pole grid, or two mesh entities with the same vertices count and triangle connectivity. Poles (or vertices) are ' +
    'interpolated linearly in world coordinates, so t 0 reproduces fromId, t 1 reproduces toId, and two planes z 0 and z 10 morph at t 0.3 into the plane z 3. ' +
    'Both inputs are kept; the result is one new entity of the same kind. Use it for blending design variants and for animation frames. ' +
    'Refuses ids that do not exist (DEF_ENTITY_NOT_FOUND), entities of different structure (DEF_MORPH_INCOMPATIBLE, with the first difference found: a topology change needs implicit modelling) ' +
    'and t outside 0..1 (DEF_MORPH_PARAMETER).',
  params: z.object({
    fromId: z.string().describe('Id of the entity at t = 0 (nurbs_curve, nurbs_surface or mesh).'),
    toId: z.string().describe('Id of the entity at t = 1; must have the same structure as fromId.'),
    t: z.number().describe('Fraction of the way from fromId to toId, unitless, 0..1.'),
  }),
  run: (doc: CadDocument, { fromId, toId, t }): CommandResult => {
    const reject = (code: string, message: string, ids: string[], path: string): CommandResult =>
      defRejection(doc, 'morph_bodies', code, message, ids, [path]);
    const [from, to] = [doc.entities[fromId], doc.entities[toId]];
    if (from === undefined) return reject('DEF_ENTITY_NOT_FOUND', `entity '${fromId}' not found`, [fromId], 'params.fromId');
    if (to === undefined) return reject('DEF_ENTITY_NOT_FOUND', `entity '${toId}' not found`, [toId], 'params.toId');
    if (!(t >= 0 && t <= 1)) return reject('DEF_MORPH_PARAMETER', `t ${t} must lie in 0..1`, [fromId, toId], 'params.t');
    const id = nextId(from.kind === 'mesh' ? 'mesh' : from.kind === 'nurbs_surface' ? 'surface' : 'curve');
    let created: Entity | string;
    if (from.kind === 'nurbs_curve' && to.kind === 'nurbs_curve') {
      const curve = morphCurves(worldCurve(from as NurbsCurveEntity), worldCurve(to as NurbsCurveEntity), t);
      created =
        typeof curve === 'string' ? curve : newEntity('nurbs_curve', id, { curve }, [0, 0, 0], from.color, { layerId: from.layerId });
    } else if (from.kind === 'nurbs_surface' && to.kind === 'nurbs_surface') {
      const surface = morphSurfaces(worldSurface(from as NurbsSurfaceEntity), worldSurface(to as NurbsSurfaceEntity), t);
      created =
        typeof surface === 'string'
          ? surface
          : newEntity('nurbs_surface', id, { surface }, [0, 0, 0], from.color, { layerId: from.layerId });
    } else if (from.kind === 'mesh' && to.kind === 'mesh') {
      const mesh = morphMeshes(from, to, t);
      created = typeof mesh === 'string' ? mesh : newEntity('mesh', id, { mesh }, [0, 0, 0], from.color, { layerId: from.layerId });
    } else created = `'${fromId}' is a ${from.kind} and '${toId}' a ${to.kind}: only two curves, two sheets or two meshes can be morphed`;
    if (typeof created === 'string') return reject('DEF_MORPH_INCOMPATIBLE', created, [fromId, toId], 'params.toId');
    return {
      ...changed(withEntities(doc, [created]), `morph_bodies: '${id}' (${from.kind}) is ${t} of the way from '${fromId}' to '${toId}'.`, [
        id,
      ]),
      data: { id, kind: from.kind, t, fromId, toId },
    };
  },
});
