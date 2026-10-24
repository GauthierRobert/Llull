/** edit_nurbs_surface: pole, weight and point-drag edits and the shape-preserving knot insertion, degree elevation, reversal and transposition of a nurbs_surface. */

import type { NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed } from '../noop';
import { FALLOFF_SHAPES } from '../../lib/falloff';
import { dragSurfacePoint } from '../../lib/nurbs/pointDrag';
import { surfacePoleWeights } from '../../lib/nurbs/poleFalloff';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import { elevateSurface, insertSurfaceKnot, reverseSurface, transposeSurface } from '../../lib/nurbs/surfaceEdit';
import { type NurbsSurfaceData, surfaceViolation } from '../../lib/nurbs/surfaceTypes';
import { distance3, sub3 } from '../../lib/vec3';
import { replaceEntity } from '../entity/entityOps';
import { refuseDirNurbs } from './dirNurbsCodes';
import { refuseSrf } from './shared';
import { isRefusal, surfaceEntityOf } from './surfaceShared';

const COMMAND = 'edit_nurbs_surface';
const OPERATIONS = ['move_poles', 'set_weight', 'drag_point', 'insert_knot', 'elevate_degree', 'reverse', 'transpose'] as const;

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
  params: z.object({
    id: z.string().describe('Id of a nurbs_surface entity.'),
    operation: z.enum(OPERATIONS).describe('Which edit to apply; the other params depend on it.'),
    poles: z
      .array(z.tuple([z.number().int(), z.number().int()]))
      .describe('move_poles: selected poles as [i, j] index pairs.')
      .optional(),
    rows: z.array(z.number().int()).describe('move_poles: select every pole of these u-rows (first index i).').optional(),
    cols: z.array(z.number().int()).describe('move_poles: select every pole of these v-columns (second index j).').optional(),
    rect: z
      .object({
        i0: z.number().int().describe('First row (inclusive).'),
        i1: z.number().int().describe('Last row (inclusive).'),
        j0: z.number().int().describe('First column (inclusive).'),
        j1: z.number().int().describe('Last column (inclusive).'),
      })
      .describe('move_poles: select the block of poles i0..i1, j0..j1.')
      .optional(),
    delta: vec3('move_poles: translation [x, y, z] in document units added to each selected pole.').optional(),
    falloff: z
      .object({
        radiusU: z.number().min(0).describe('Falloff radius along u in pole-index units (0 = no spread along u).'),
        radiusV: z.number().min(0).describe('Falloff radius along v in pole-index units (0 = no spread along v).'),
        shape: z.enum(FALLOFF_SHAPES).describe('Weight curve, default smooth.').optional(),
      })
      .describe('move_poles: soft selection; distance is max(|di| / radiusU, |dj| / radiusV) to the nearest selected pole.')
      .optional(),
    i: z.number().int().describe('set_weight: pole row index (along u).').optional(),
    j: z.number().int().describe('set_weight: pole column index (along v).').optional(),
    weight: z.number().describe('set_weight: new weight, finite and > 0.').optional(),
    u: z
      .number()
      .describe('drag_point: parameter along u. insert_knot with direction "u": the knot to insert (strictly inside the domain).')
      .optional(),
    v: z
      .number()
      .describe('drag_point: parameter along v. insert_knot with direction "v": the knot to insert (strictly inside the domain).')
      .optional(),
    displacement: vec3('drag_point: how far S(u, v) moves [x, y, z] in document units.').optional(),
    direction: z.enum(['u', 'v']).describe('insert_knot / elevate_degree / reverse: the parameter direction.').optional(),
    times: z.number().int().describe('insert_knot: how many times to insert the knot, default 1.').optional(),
    by: z.number().int().describe('elevate_degree: how many degrees to add, default 1.').optional(),
  }),
  run: (doc, params): CommandResult => {
    const entity = surfaceEntityOf(doc, COMMAND, params.id);
    if (isRefusal(entity)) return entity;
    const { surface } = entity;
    const countU = surface.poles.length;
    const countV = (surface.poles[0] as ReadonlyArray<Vec3>).length;
    const missing = (what: string, path: string): CommandResult =>
      refuseDirNurbs(doc, COMMAND, 'DIR_OPERATION_PARAMS', `${params.operation} needs ${what}`, [params.id], [`params.${path}`]);
    const range = (message: string, path: string): CommandResult =>
      refuseDirNurbs(doc, COMMAND, 'DIR_POLE_RANGE', message, [params.id], [`params.${path}`]);
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, COMMAND, 'SRF_NURBS_INVALID', message, [params.id], [`params.${path}`]);
    const direction = params.direction;
    let result: NurbsSurfaceData | string;
    let detail = '';
    switch (params.operation) {
      case 'move_poles': {
        const { delta } = params;
        if (delta === undefined) return missing('delta', 'delta');
        const selected: Array<readonly [number, number]> = [...(params.poles ?? [])];
        for (const [k, [pi, pj]] of selected.entries())
          if (pi < 0 || pi >= countU || pj < 0 || pj >= countV)
            return range(`pole [${pi}, ${pj}] is outside the ${countU} x ${countV} grid`, `poles.${k}`);
        for (const [k, row] of (params.rows ?? []).entries()) {
          if (row < 0 || row >= countU) return range(`row ${row} is outside 0..${countU - 1}`, `rows.${k}`);
          for (let j = 0; j < countV; j++) selected.push([row, j]);
        }
        for (const [k, col] of (params.cols ?? []).entries()) {
          if (col < 0 || col >= countV) return range(`column ${col} is outside 0..${countV - 1}`, `cols.${k}`);
          for (let i = 0; i < countU; i++) selected.push([i, col]);
        }
        const { rect } = params;
        if (rect !== undefined) {
          if (rect.i0 < 0 || rect.i1 >= countU || rect.i0 > rect.i1)
            return range(`rect rows ${rect.i0}..${rect.i1} are outside 0..${countU - 1}`, 'rect');
          if (rect.j0 < 0 || rect.j1 >= countV || rect.j0 > rect.j1)
            return range(`rect columns ${rect.j0}..${rect.j1} are outside 0..${countV - 1}`, 'rect');
          for (let i = rect.i0; i <= rect.i1; i++) for (let j = rect.j0; j <= rect.j1; j++) selected.push([i, j]);
        }
        if (selected.length === 0) return missing('poles, rows, cols or rect', 'poles');
        const weights = surfacePoleWeights(
          countU,
          countV,
          selected,
          params.falloff?.radiusU ?? 0,
          params.falloff?.radiusV ?? 0,
          params.falloff?.shape ?? 'smooth',
        );
        const moved = weights.flat().filter((w) => w > 0).length;
        detail = `; ${selected.length} selected, ${moved} pole(s) moved`;
        result = {
          ...surface,
          poles: surface.poles.map((row, i) =>
            row.map((p, j): Vec3 => {
              const w = (weights[i] as number[])[j] as number;
              return w === 0 ? p : [p[0] + w * delta[0], p[1] + w * delta[1], p[2] + w * delta[2]];
            }),
          ),
        };
        break;
      }
      case 'set_weight': {
        const { i, j, weight } = params;
        if (i === undefined || j === undefined || weight === undefined) return missing('i, j and weight', 'i');
        if (i < 0 || i >= countU || j < 0 || j >= countV) return range(`pole [${i}, ${j}] is outside the ${countU} x ${countV} grid`, 'i');
        if (!(Number.isFinite(weight) && weight > 0)) return invalid(`weight must be finite and > 0 (got ${weight})`, 'weight');
        result = {
          ...surface,
          weights: surface.poles.map((row, r) => row.map((_, c) => (r === i && c === j ? weight : (surface.weights?.[r]?.[c] ?? 1)))),
        };
        break;
      }
      case 'drag_point': {
        const { u, v, displacement } = params;
        if (u === undefined || v === undefined || displacement === undefined) return missing('u, v and displacement', 'u');
        const dragged = dragSurfacePoint(surface, u, v, displacement);
        if (typeof dragged === 'string')
          return refuseDirNurbs(doc, COMMAND, 'DIR_POINT_OUTSIDE_DOMAIN', dragged, [params.id], ['params.u']);
        const error = distance3(sub3(evaluateSurface(dragged, u, v), evaluateSurface(surface, u, v)), displacement);
        detail = `; S(${u}, ${v}) moved by exactly the displacement (error ${error.toExponential(1)} ${doc.units})`;
        result = dragged;
        break;
      }
      case 'insert_knot': {
        const value = direction === 'v' ? params.v : params.u;
        if (direction === undefined || value === undefined)
          return missing('direction and the knot in u (direction "u") or v (direction "v")', 'direction');
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
        result = insertSurfaceKnot(surface, direction, value, params.times ?? 1);
        break;
      }
      case 'elevate_degree':
        if (direction === undefined) return missing('direction', 'direction');
        result = elevateSurface(surface, direction, params.by ?? 1);
        break;
      case 'reverse':
      case 'transpose':
        if (params.operation === 'reverse' && direction === undefined) return missing('direction', 'direction');
        if ((entity.trims?.length ?? 0) > 0)
          return refuseDirNurbs(
            doc,
            COMMAND,
            'DIR_TRIMS_BLOCK',
            `${params.operation} would invalidate the trim loops of "${params.id}"`,
            [params.id],
            ['params.operation'],
          );
        result = params.operation === 'transpose' ? transposeSurface(surface) : reverseSurface(surface, direction as 'u' | 'v');
        break;
    }
    if (typeof result === 'string') return invalid(result, 'operation');
    const violation = surfaceViolation(result);
    if (violation !== null) return invalid(violation.message, violation.path);
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
