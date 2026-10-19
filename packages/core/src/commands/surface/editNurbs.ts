/** edit_nurbs: pole / weight edits and the shape-preserving knot insertion, degree elevation and reversal of a nurbs_curve. */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed } from '../noop';
import { elevateDegree, insertKnot, movePole, reverseCurve, setWeight } from '../../lib/nurbs/edit';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { distance3 } from '../../lib/vec3';
import { replaceEntity } from '../entity/entityOps';
import { curveEntityOf, refuseSrf } from './shared';

const OPERATIONS = ['move_pole', 'set_weight', 'insert_knot', 'elevate_degree', 'reverse'] as const;

/** Largest distance between `a` and `b` over 33 equal parameter steps (the shape change of a shape-preserving edit). */
function shapeChange(a: NurbsCurveData, b: NurbsCurveData): number {
  const [first, last] = curveDomain(a);
  let worst = 0;
  for (let i = 0; i <= 32; i++) {
    const u = first + ((last - first) * i) / 32;
    worst = Math.max(worst, distance3(evaluateCurve(a, u), evaluateCurve(b, u)));
  }
  return worst;
}

/**
 * @affects modifies 1 nurbs_curve entity
 * @invariant insert_knot and elevate_degree keep the shape (reported deviation ~1e-13); reverse keeps the shape and flips direction
 * @failure unknown id / not a nurbs_curve -> SRF_ENTITY_NOT_FOUND / SRF_NOT_NURBS; missing or out-of-range operand, knot outside the domain, multiplicity above the degree -> SRF_NURBS_INVALID
 */
export const editNurbs = defineCommand({
  name: 'edit_nurbs',
  description:
    'Edit a nurbs_curve in place. `operation`: "move_pole" (`index`, `to` [x,y,z]: moves one control point, changes the shape), "set_weight" ' +
    '(`index`, `weight` > 0: makes the curve rational, changes the shape), "insert_knot" (`u` strictly inside the domain, `times` default 1: adds ' +
    'control points WITHOUT changing the shape, for local editing), "elevate_degree" (`by` default 1: raises the degree WITHOUT changing the shape), ' +
    '"reverse" (flips the direction). The summary reports the measured shape change for the shape-preserving operations. Look at the current ' +
    'definition with inspect_nurbs first.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_curve entity.'),
    operation: z.enum(OPERATIONS).describe('Which edit to apply; the other params depend on it.'),
    index: z.number().describe('move_pole / set_weight: pole index, 0-based.').optional(),
    to: vec3('move_pole: new pole position [x, y, z] in document units, relative to the entity position.').optional(),
    weight: z.number().describe('set_weight: new weight, finite and > 0.').optional(),
    u: z.number().describe('insert_knot: parameter to insert, strictly inside the knot domain (see inspect_nurbs).').optional(),
    times: z
      .number()
      .describe('insert_knot: how many times to insert it, default 1 (total multiplicity may not exceed the degree).')
      .optional(),
    by: z.number().describe('elevate_degree: how many degrees to add, default 1 (result at most 25).').optional(),
  }),
  run: (doc, { id, operation, index, to, weight, u, times = 1, by = 1 }): CommandResult => {
    const entity = curveEntityOf(doc, 'edit_nurbs', id);
    if (!('curve' in entity)) return entity;
    const refuse = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'edit_nurbs', 'SRF_NURBS_INVALID', message, [id], [`params.${path}`]);
    let result: NurbsCurveData | string;
    switch (operation) {
      case 'move_pole':
        if (index === undefined || to === undefined) return refuse('move_pole needs index and to', 'index');
        result = movePole(entity.curve, index, to);
        break;
      case 'set_weight':
        if (index === undefined || weight === undefined) return refuse('set_weight needs index and weight', 'index');
        result = setWeight(entity.curve, index, weight);
        break;
      case 'insert_knot':
        if (u === undefined) return refuse('insert_knot needs u', 'u');
        result = insertKnot(entity.curve, u, times);
        break;
      case 'elevate_degree':
        result = elevateDegree(entity.curve, by);
        break;
      case 'reverse':
        result = reverseCurve(entity.curve);
        break;
    }
    if (typeof result === 'string')
      return refuse(result, operation === 'insert_knot' ? 'u' : operation === 'elevate_degree' ? 'by' : 'index');
    const preserving = operation === 'insert_knot' || operation === 'elevate_degree';
    const detail = preserving ? `; shape change ${shapeChange(entity.curve, result).toExponential(1)} ${doc.units}` : '';
    return changed(
      replaceEntity(doc, { ...entity, curve: result }),
      `edit_nurbs ${id}: ${operation} -> degree ${result.degree}, ${result.poles.length} poles${detail}.`,
      [id],
    );
  },
});
