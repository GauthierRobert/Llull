/** section_field: the numeric cut of a field or body by a plane (05 IMP 4.4, FR-IMP-32): loops, areas, solid fraction, optional SVG. */

import { defineCommand, vec3, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { resolveFieldEngine } from '@core/geometry/field/engine';
import type { Vec3 } from '@core/model/types';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { contourLoops } from './contour';
import { resolveTarget } from './measure';

const MAX_RESOLUTION = 400;
const MAX_LISTED_POINTS = 2000;

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** In-plane axes of the plane with unit normal `n`: u along the world axis least aligned with n, v = n x u. */
function planeAxes(n: Vec3): { u: Vec3; v: Vec3 } {
  const helper: Vec3 =
    Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2])
      ? [1, 0, 0]
      : Math.abs(n[1]) <= Math.abs(n[2])
        ? [0, 1, 0]
        : [0, 0, 1];
  const u = unit(cross(helper, n));
  return { u, v: cross(n, u) };
}

const decimate = <T>(points: readonly T[], limit: number): T[] => {
  if (points.length <= limit) return [...points];
  const stride = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % stride === 0);
};

/**
 * @affects none (read-only); data = loops[] {role, area, perimeter, points}, solidArea, solidFraction, sampleSolidFraction, sampling, provenance
 * @invariant loops come from marching squares on (resolution+1)^2 samples of the field (error second order in size / resolution); outer loops run counter-clockwise (positive area), holes clockwise (negative); the edge of the sampled square closes material cut by it
 * @failure unknown field or body -> IMP_FIELD_NOT_FOUND; size <= 0, resolution outside 8..400, zero normal -> IMP_PARAM_RANGE
 */
export const sectionField = defineCommand({
  name: 'section_field',
  description:
    'Cut an implicit field or body by a plane and report the section as numbers: closed boundary loops (outer loops positive area, holes negative), their perimeters, the solid area, and the solid fraction of the sampled square ' +
    '(the numeric version of a section view; use it to see the inside of a lattice). The plane is given by a point and a normal; the sampled square has side `size` (document units), is centred on the point and uses a resolution x resolution grid ' +
    '(resolution 8..400; the area error falls with its square). Loops are decimated to 2000 points each; svg true adds an SVG drawing of the section in data.svg (save it with --save).',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({
    id: z.string().describe('Id of a field node or of an implicit body.'),
    plane: z
      .object({
        origin: vec3('A point on the plane [x, y, z] in document units: the centre of the sampled square.'),
        normal: vec3('Plane normal [x, y, z] (non-zero).'),
      })
      .describe('The cutting plane.'),
    size: z.number().describe('Side of the sampled square in document units (> 0).'),
    resolution: z.number().optional().describe(`Samples along each side of the square (integer 8..${MAX_RESOLUTION}, default 200).`),
    svg: z.boolean().optional().describe('Also return an SVG drawing of the loops in data.svg.'),
  }),
  run: (doc, { id, plane, size, resolution = 200, svg = false }, ctx): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseImplicit(doc, 'section_field', code, message, [], [`params.${path}`]);
    const target = resolveTarget(doc, id);
    if (target === undefined)
      return refuseImplicit(doc, 'section_field', 'IMP_FIELD_NOT_FOUND', `no field or body '${id}'`, [id], ['params.id']);
    if (!(Number.isFinite(size) && size > 0)) return fail('IMP_PARAM_RANGE', `size must be > 0 (got ${size})`, 'size');
    const n = Math.round(resolution);
    if (!(n >= 8 && n <= MAX_RESOLUTION))
      return fail('IMP_PARAM_RANGE', `resolution must be an integer 8..${MAX_RESOLUTION} (got ${resolution})`, 'resolution');
    if (!(Math.hypot(...plane.normal) > 0)) return fail('IMP_PARAM_RANGE', 'plane.normal must be non-zero', 'plane.normal');
    const compiled = compileField(doc, target.fieldId);
    if (!compiled.ok) return refuseImplicit(doc, 'section_field', compiled.code, compiled.message, compiled.ids);
    const normal = unit(plane.normal);
    const { u, v } = planeAxes(normal);
    const step = size / n;
    const columns = n + 1;
    const points = new Float64Array(columns * columns * 3);
    for (let j = 0; j < columns; j += 1)
      for (let i = 0; i < columns; i += 1) {
        const [s, t] = [(i - n / 2) * step, (j - n / 2) * step];
        const at = (i + columns * j) * 3;
        for (const axis of [0, 1, 2] as const) points[at + axis] = plane.origin[axis] + u[axis] * s + v[axis] * t;
      }
    const engine = resolveFieldEngine(ctx?.fieldEngine);
    const answer = engine.evaluate(compiled.program, points, false);
    if (answer.failure !== undefined) return refuseImplicit(doc, 'section_field', answer.failure.code, answer.failure.message, [id]);
    const loops = contourLoops(answer.values, columns, columns, step, [-size / 2, -size / 2]);
    const inside = answer.values.reduce((count, value) => count + (value < 0 ? 1 : 0), 0);
    const solidArea = loops.reduce((sum, loop) => sum + loop.area, 0);
    const lift = (p: readonly [number, number]): Vec3 => [
      plane.origin[0] + u[0] * p[0] + v[0] * p[1],
      plane.origin[1] + u[1] * p[0] + v[1] * p[1],
      plane.origin[2] + u[2] * p[0] + v[2] * p[1],
    ];
    const listed = loops
      .map((loop) => ({
        role: loop.area >= 0 ? 'outer' : 'hole',
        area: loop.area,
        perimeter: loop.perimeter,
        pointCount: loop.points.length,
        points: decimate(loop.points, MAX_LISTED_POINTS).map(lift),
      }))
      .sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const path = (loop: (typeof loops)[number]): string =>
      `<path d="M${loop.points.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join('L')}Z" fill="${loop.area >= 0 ? '#bbbbbb' : '#ffffff'}" stroke="#222222" stroke-width="${size / 400}"/>`;
    const drawing = svg
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-size / 2} ${-size / 2} ${size} ${size}"><g transform="scale(1,-1)">${loops.map(path).join('')}</g></svg>`
      : undefined;
    const perimeter = listed.reduce((sum, loop) => sum + loop.perimeter, 0);
    return report(
      doc,
      `section_field: ${id} by the plane through [${plane.origin.join(', ')}] normal [${normal.map((c) => c.toFixed(3)).join(', ')}]: ${listed.length} loop(s), solid area ${solidArea.toPrecision(6)} ${doc.units}^2 = ${((100 * solidArea) / (size * size)).toFixed(2)} % of the ${size} x ${size} square (${n} x ${n} samples).`,
      {
        id,
        field: target.fieldId,
        sampling: { origin: plane.origin, normal, u, v, size, resolution: n, step },
        loops: listed,
        loopCount: listed.length,
        solidArea,
        solidFraction: solidArea / (size * size),
        sampleSolidFraction: inside / (columns * columns),
        areaUnit: `${doc.units}^2`,
        errorEstimate: {
          kind: 'estimated',
          basis: 'second order in the sample step along the boundary',
          value: step * step * Math.max(1, perimeter) * 0.1,
        },
        ...(drawing === undefined ? {} : { svg: drawing }),
        distanceQuality: compiled.program.quality,
        unit: doc.units,
        unverified: compiled.unverified,
        provenance: {
          method: 'marching squares on sampled field values',
          engine: engine.name,
          samples: columns * columns,
          deterministic: true,
        },
      },
    );
  },
});
