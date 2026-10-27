/** evaluate_field: signed values (and gradients) of a field at points or on a plane grid (05 IMP 4.4). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { fieldOf } from './model';

const MAX_POINTS = 10_000;
const MAX_GRID = 200;

const PLANE_AXES = { XY: [0, 1, 2], XZ: [0, 2, 1], YZ: [1, 2, 0] } as const;

/**
 * @affects none (read-only); data = values (+ gradients), distanceQuality, lipschitz, unit, provenance
 * @invariant at most 10000 samples; negative values are inside the field's solid; gradients of exact fields have unit length
 * @invariant field-engine-optional: reads ctx.fieldEngine when present, else the built-in TS engine (no kernel is needed)
 * @failure unknown field -> IMP_FIELD_NOT_FOUND; both or neither of points / grid, too many samples -> IMP_PARAM_RANGE
 */
export const evaluateField = defineCommand({
  name: 'evaluate_field',
  description:
    'Sample an implicit FIELD: signed value (negative inside, in document units; exact only if distanceQuality is "exact", otherwise a bound or approximation), optionally the gradient, ' +
    'at up to 10000 points or on a plane grid (up to 200x200). Use it to probe a thickness, check a blend tangent point or read a lattice law instead of rendering. ' +
    'Give exactly one of points or grid. data: values[], gradients[] (when gradient is true), distanceQuality, lipschitz, nonFiniteSamples.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    field: z.string().describe('Id of the field node to sample.'),
    points: z
      .array(vec3('Sample point [x, y, z] in document units.'))
      .max(MAX_POINTS)
      .optional()
      .describe(`Up to ${MAX_POINTS} points [x, y, z].`),
    grid: z
      .object({
        plane: z.enum(['XY', 'XZ', 'YZ']).describe('Plane of the grid.'),
        offset: z.number().describe('Coordinate of the plane along its normal, in document units.'),
        min: z.array(z.number()).length(2).describe('Lower corner [u, v] in the plane axes (XY: x,y; XZ: x,z; YZ: y,z).'),
        max: z.array(z.number()).length(2).describe('Upper corner [u, v].'),
        n: z.array(z.number()).length(2).describe(`Sample counts [nu, nv], each 1..${MAX_GRID}.`),
      })
      .optional()
      .describe('Alternative to points: a regular grid on an axis-aligned plane (row-major, u fastest).'),
    gradient: z.boolean().optional().describe('Also return the gradient (3 numbers per sample). Default false.'),
  }),
  run: (doc, p, ctx): CommandResult => {
    const range = (message: string, path: string): CommandResult =>
      refuseImplicit(doc, 'evaluate_field', 'IMP_PARAM_RANGE', message, [], [`params.${path}`]);
    if (fieldOf(doc, p.field) === undefined)
      return refuseImplicit(doc, 'evaluate_field', 'IMP_FIELD_NOT_FOUND', `no field '${p.field}'`, [p.field], ['params.field']);
    if ((p.points === undefined) === (p.grid === undefined)) return range('give exactly one of points or grid', 'points');
    let samples: number[];
    if (p.points !== undefined) samples = p.points.flat();
    else if (p.grid !== undefined) {
      const { plane, offset, min, max, n } = p.grid;
      const [nu, nv] = [Math.floor(n[0] as number), Math.floor(n[1] as number)];
      if (!(nu >= 1 && nv >= 1 && nu <= MAX_GRID && nv <= MAX_GRID && nu * nv <= MAX_POINTS))
        return range(`grid counts must be 1..${MAX_GRID} each with at most ${MAX_POINTS} samples (got ${nu} x ${nv})`, 'grid.n');
      const [u, v, w] = PLANE_AXES[plane];
      samples = [];
      for (let j = 0; j < nv; j += 1)
        for (let i = 0; i < nu; i += 1) {
          const point = [0, 0, 0];
          point[u] = (min[0] as number) + (nu === 1 ? 0 : ((max[0] as number) - (min[0] as number)) * (i / (nu - 1)));
          point[v] = (min[1] as number) + (nv === 1 ? 0 : ((max[1] as number) - (min[1] as number)) * (j / (nv - 1)));
          point[w] = offset;
          samples.push(...point);
        }
    } else samples = [];
    const compiled = compileField(doc, p.field);
    if (!compiled.ok) return refuseImplicit(doc, 'evaluate_field', compiled.code, compiled.message, compiled.ids);
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const answer = engine.evaluate(compiled.program, Float64Array.from(samples), p.gradient === true);
    if (answer.failure !== undefined) return refuseImplicit(doc, 'evaluate_field', answer.failure.code, answer.failure.message, [p.field]);
    const count = samples.length / 3;
    return report(doc, `evaluate_field: ${count} sample(s) of ${p.field} (distance ${compiled.program.quality}, ${doc.units}).`, {
      field: p.field,
      count,
      values: Array.from(answer.values),
      ...(answer.gradients === null ? {} : { gradients: Array.from(answer.gradients) }),
      distanceQuality: compiled.program.quality,
      lipschitzIsEstimate: compiled.program.quality === 'approximate',
      lipschitz: compiled.program.lipschitz,
      nonFiniteSamples: answer.nonFinite,
      unit: doc.units,
      unverified: compiled.unverified,
      provenance: { method: 'tape interpreter, f64', engine: engine.name, deterministic: true },
    });
  },
});
