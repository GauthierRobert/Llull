/** The per-operation edits of edit_nurbs_surface: each returns the edited surface (or a violation message) with its summary detail, or a refusal. */

import type { CadDocument, NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { dragSurfacePoint } from '../../lib/nurbs/pointDrag';
import { surfacePoleWeights } from '../../lib/nurbs/poleFalloff';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import { elevateSurface, insertSurfaceKnot, reverseSurface, transposeSurface } from '../../lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { distance3, sub3 } from '../../lib/vec3';
import { refuseDirNurbs } from './dirNurbsCodes';
import type { EditParams } from './editNurbsSurfaceParams';
import { refuseSrf } from './shared';

export const COMMAND = 'edit_nurbs_surface';

export interface EditEnv {
  readonly doc: CadDocument;
  readonly params: EditParams;
  readonly entity: NurbsSurfaceEntity;
  readonly surface: NurbsSurfaceData;
  readonly countU: number;
  readonly countV: number;
}

export interface Edited {
  readonly result: NurbsSurfaceData | string;
  readonly detail: string;
}

export const isEdited = (value: Edited | CommandResult): value is Edited => 'result' in value;

export const missing = (env: EditEnv, what: string, path: string): CommandResult =>
  refuseDirNurbs(env.doc, COMMAND, 'DIR_OPERATION_PARAMS', `${env.params.operation} needs ${what}`, [env.params.id], [`params.${path}`]);
const range = (env: EditEnv, message: string, path: string): CommandResult =>
  refuseDirNurbs(env.doc, COMMAND, 'DIR_POLE_RANGE', message, [env.params.id], [`params.${path}`]);
export const invalid = (env: EditEnv, message: string, path: string): CommandResult =>
  refuseSrf(env.doc, COMMAND, 'SRF_NURBS_INVALID', message, [env.params.id], [`params.${path}`]);

/** The poles named by `poles`, `rows`, `cols` and `rect`, in that order; a refusal when one is outside the grid. */
function selectPoles(env: EditEnv): Array<readonly [number, number]> | CommandResult {
  const { params, countU, countV } = env;
  const selected: Array<readonly [number, number]> = [...(params.poles ?? [])];
  for (const [k, [pi, pj]] of selected.entries())
    if (pi < 0 || pi >= countU || pj < 0 || pj >= countV)
      return range(env, `pole [${pi}, ${pj}] is outside the ${countU} x ${countV} grid`, `poles.${k}`);
  for (const [k, row] of (params.rows ?? []).entries()) {
    if (row < 0 || row >= countU) return range(env, `row ${row} is outside 0..${countU - 1}`, `rows.${k}`);
    for (let j = 0; j < countV; j++) selected.push([row, j]);
  }
  for (const [k, col] of (params.cols ?? []).entries()) {
    if (col < 0 || col >= countV) return range(env, `column ${col} is outside 0..${countV - 1}`, `cols.${k}`);
    for (let i = 0; i < countU; i++) selected.push([i, col]);
  }
  const { rect } = params;
  if (rect !== undefined) {
    if (rect.i0 < 0 || rect.i1 >= countU || rect.i0 > rect.i1)
      return range(env, `rect rows ${rect.i0}..${rect.i1} are outside 0..${countU - 1}`, 'rect');
    if (rect.j0 < 0 || rect.j1 >= countV || rect.j0 > rect.j1)
      return range(env, `rect columns ${rect.j0}..${rect.j1} are outside 0..${countV - 1}`, 'rect');
    for (let i = rect.i0; i <= rect.i1; i++) for (let j = rect.j0; j <= rect.j1; j++) selected.push([i, j]);
  }
  return selected;
}

export function movePoles(env: EditEnv): Edited | CommandResult {
  const { params, surface, countU, countV } = env;
  const { delta } = params;
  if (delta === undefined) return missing(env, 'delta', 'delta');
  const selected = selectPoles(env);
  if ('document' in selected) return selected;
  if (selected.length === 0) return missing(env, 'poles, rows, cols or rect', 'poles');
  const weights = surfacePoleWeights(
    countU,
    countV,
    selected,
    params.falloff?.radiusU ?? 0,
    params.falloff?.radiusV ?? 0,
    params.falloff?.shape ?? 'smooth',
  );
  const moved = weights.flat().filter((w) => w > 0).length;
  return {
    detail: `; ${selected.length} selected, ${moved} pole(s) moved`,
    result: {
      ...surface,
      poles: surface.poles.map((row, i) =>
        row.map((p, j): Vec3 => {
          const w = (weights[i] as number[])[j] as number;
          return w === 0 ? p : [p[0] + w * delta[0], p[1] + w * delta[1], p[2] + w * delta[2]];
        }),
      ),
    },
  };
}

export function setWeight(env: EditEnv): Edited | CommandResult {
  const { params, surface, countU, countV } = env;
  const { i, j, weight } = params;
  if (i === undefined || j === undefined || weight === undefined) return missing(env, 'i, j and weight', 'i');
  if (i < 0 || i >= countU || j < 0 || j >= countV) return range(env, `pole [${i}, ${j}] is outside the ${countU} x ${countV} grid`, 'i');
  if (!(Number.isFinite(weight) && weight > 0)) return invalid(env, `weight must be finite and > 0 (got ${weight})`, 'weight');
  return {
    detail: '',
    result: {
      ...surface,
      weights: surface.poles.map((row, r) => row.map((_, c) => (r === i && c === j ? weight : (surface.weights?.[r]?.[c] ?? 1)))),
    },
  };
}

export function dragPoint(env: EditEnv): Edited | CommandResult {
  const { doc, params, surface } = env;
  const { u, v, displacement } = params;
  if (u === undefined || v === undefined || displacement === undefined) return missing(env, 'u, v and displacement', 'u');
  const dragged = dragSurfacePoint(surface, u, v, displacement);
  if (typeof dragged === 'string') return refuseDirNurbs(doc, COMMAND, 'DIR_POINT_OUTSIDE_DOMAIN', dragged, [params.id], ['params.u']);
  const error = distance3(sub3(evaluateSurface(dragged, u, v), evaluateSurface(surface, u, v)), displacement);
  return { detail: `; S(${u}, ${v}) moved by exactly the displacement (error ${error.toExponential(1)} ${doc.units})`, result: dragged };
}

export function insertKnot(env: EditEnv): Edited | CommandResult {
  const { doc, params, surface } = env;
  const { direction } = params;
  const value = direction === 'v' ? params.v : params.u;
  if (direction === undefined || value === undefined)
    return missing(env, 'direction and the knot in u (direction "u") or v (direction "v")', 'direction');
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const [lo, hi] = direction === 'u' ? [u0, u1] : [v0, v1];
  if (!(value > lo && value < hi))
    return refuseDirNurbs(
      doc,
      COMMAND,
      'DIR_POINT_OUTSIDE_DOMAIN',
      `knot ${value} must lie strictly inside (${lo}, ${hi})`,
      [params.id],
      [`params.${direction}`],
    );
  return { detail: '', result: insertSurfaceKnot(surface, direction, value, params.times ?? 1) };
}

export function elevateDegree(env: EditEnv): Edited | CommandResult {
  const { params, surface } = env;
  const { direction } = params;
  if (direction === undefined) return missing(env, 'direction', 'direction');
  return { detail: '', result: elevateSurface(surface, direction, params.by ?? 1) };
}

export function reverseOrTranspose(env: EditEnv): Edited | CommandResult {
  const { doc, params, entity, surface } = env;
  const { direction } = params;
  if (params.operation === 'reverse' && direction === undefined) return missing(env, 'direction', 'direction');
  if ((entity.trims?.length ?? 0) > 0)
    return refuseDirNurbs(
      doc,
      COMMAND,
      'DIR_TRIMS_BLOCK',
      `${params.operation} would invalidate the trim loops of "${params.id}"`,
      [params.id],
      ['params.operation'],
    );
  return {
    detail: '',
    result: params.operation === 'transpose' ? transposeSurface(surface) : reverseSurface(surface, direction as 'u' | 'v'),
  };
}
