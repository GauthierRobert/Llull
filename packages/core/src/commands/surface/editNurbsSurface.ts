/** edit_nurbs_surface: pole, weight and point-drag edits and the shape-preserving knot insertion, degree elevation, reversal and transposition of a nurbs_surface. */

import type { NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand } from '../schema';
import { changed } from '../noop';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import { type NurbsSurfaceData, surfaceViolation } from '../../lib/nurbs/surfaceTypes';
import { distance3 } from '../../lib/vec3';
import { replaceEntity } from '../entity/entityOps';
import {
  COMMAND,
  dragPoint,
  type Edited,
  type EditEnv,
  elevateDegree,
  insertKnot,
  invalid,
  isEdited,
  movePoles,
  reverseOrTranspose,
  setWeight,
} from './editNurbsSurfaceOps';
import { editNurbsSurfaceParams } from './editNurbsSurfaceParams';
import { isRefusal, surfaceEntityOf } from './surfaceShared';

/** Largest distance between `a` and `b` over a 17 x 17 parameter grid (the shape change of a shape-preserving edit). */
function shapeChange(a: NurbsSurfaceData, b: NurbsSurfaceData): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(a);
  let worst = 0;
  for (let i = 0; i <= 16; i++)
    for (let j = 0; j <= 16; j++) {
      const [u, v] = [u0 + ((u1 - u0) * i) / 16, v0 + ((v1 - v0) * j) / 16];
      worst = Math.max(worst, distance3(evaluateSurface(a, u, v), evaluateSurface(b, u, v)));
    }
  return worst;
}

/**
 * @affects modifies 1 nurbs_surface entity
 * @invariant drag_point moves S(u, v) by exactly `displacement` (<= 1e-12) with the least-norm pole change; insert_knot / elevate_degree keep the shape (reported); trims survive every operation except reverse / transpose (refused)
 * @failure unknown id / not a nurbs_surface -> SRF_ENTITY_NOT_FOUND / SRF_NOT_SURFACE; pole index outside the grid -> DIR_POLE_RANGE; (u, v) outside the domain -> DIR_POINT_OUTSIDE_DOMAIN; missing operand -> DIR_OPERATION_PARAMS; invalid result -> SRF_NURBS_INVALID; reverse / transpose of a trimmed sheet -> DIR_TRIMS_BLOCK
 */
export const editNurbsSurface = defineCommand({
  name: COMMAND,
  description:
    'Edit a nurbs_surface in place. `operation`: "move_poles" (select poles with `poles` [[i, j]...], `rows` (all poles of those u-rows), `cols` or `rect` ' +
    '{ i0, i1, j0, j1 } inclusive, then `delta` [x,y,z] is added to each; optional `falloff` { radiusU, radiusV, shape } in pole-index units gives neighbours a soft weight), ' +
    '"set_weight" (`i`, `j`, `weight` > 0: makes the surface rational), "drag_point" (`u`, `v`, `displacement` [x,y,z]: S(u, v) moves by exactly that vector with the ' +
    'least-norm pole change), "insert_knot" (`direction`, the parameter in `u` or `v`, `times` default 1: more poles for local editing, shape unchanged), ' +
    '"elevate_degree" (`direction`, `by` default 1: shape unchanged), "reverse" (`direction`: flips that parameter), "transpose" (swaps u and v). ' +
    'Pole indices: i runs along u (0..nU-1), j along v (0..nV-1); inspect_nurbs lists the grid. The summary reports the measured shape change of the preserving operations. ' +
    'Refuses a pole outside the grid (DIR_POLE_RANGE) and a point outside the knot domain (DIR_POINT_OUTSIDE_DOMAIN).',
  params: editNurbsSurfaceParams,
  run: (doc, params): CommandResult => {
    const entity = surfaceEntityOf(doc, COMMAND, params.id);
    if (isRefusal(entity)) return entity;
    const { surface } = entity;
    const env: EditEnv = {
      doc,
      params,
      entity,
      surface,
      countU: surface.poles.length,
      countV: (surface.poles[0] as ReadonlyArray<Vec3>).length,
    };
    const edited = applyOperation(env);
    if (!isEdited(edited)) return edited;
    const { result } = edited;
    let { detail } = edited;
    if (typeof result === 'string') return invalid(env, result, 'operation');
    const violation = surfaceViolation(result);
    if (violation !== null) return invalid(env, violation.message, violation.path);
    if (params.operation === 'insert_knot' || params.operation === 'elevate_degree')
      detail = `; shape change ${shapeChange(surface, result).toExponential(1)} ${doc.units}`;
    const next: NurbsSurfaceEntity = { ...entity, surface: result };
    return changed(
      replaceEntity(doc, next),
      `${COMMAND} ${params.id}: ${params.operation} -> degree ${result.degreeU} x ${result.degreeV}, ${result.poles.length} x ${(result.poles[0] as ReadonlyArray<Vec3>).length} poles${detail}.`,
      [params.id],
    );
  },
});

function applyOperation(env: EditEnv): Edited | CommandResult {
  switch (env.params.operation) {
    case 'move_poles':
      return movePoles(env);
    case 'set_weight':
      return setWeight(env);
    case 'drag_point':
      return dragPoint(env);
    case 'insert_knot':
      return insertKnot(env);
    case 'elevate_degree':
      return elevateDegree(env);
    case 'reverse':
    case 'transpose':
      return reverseOrTranspose(env);
  }
}
