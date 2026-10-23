/** add_field_primitive: an exact signed-distance primitive as a field node (05 IMP 4.1). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import type { PrimitiveNode, PrimitiveShape } from './model';
import { addNode } from './nodeResult';

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * @affects creates 1 field node `fld-<step>.<k>` (no geometry until create_implicit_body)
 * @invariant exact SDF for every shape (negative inside); dims are design intent, so replay re-mints the same id
 * @failure a required dimension <= 0 or rounding >= half the smallest size -> IMP_PARAM_RANGE, unchanged document
 */
export const addFieldPrimitive = defineCommand({
  name: 'add_field_primitive',
  description:
    'Create an exact signed-distance primitive as an implicit FIELD node (negative inside, millimetres in a mm document); it has no mesh until create_implicit_body. ' +
    'Shapes and the dimensions they need: sphere (radius), box (size [x,y,z] full extents; optional rounding), cylinder (radius, height; axis +Z, centred), ' +
    'capsule (radius, height = distance between the two cap centres; axis +Z, centred), torus (ringRadius, tubeRadius; ring in the XY plane, tubeRadius < ringRadius), ' +
    'cone (radius at the base z=0, height to the apex), plane (normal, offset: the half-space normal.p < offset is inside). ' +
    'position places the shape centre (cone: base centre), rotation is Euler XYZ in radians. Use combine_fields to unite / cut / blend fields.',
  params: z.object({
    shape: z
      .enum(['sphere', 'box', 'cylinder', 'capsule', 'torus', 'cone', 'plane'])
      .describe("Primitive kind; see the command description for each kind's dimensions."),
    radius: z.number().optional().describe('sphere / cylinder / capsule / cone radius, in document units (> 0).'),
    size: vec3('box full extents [x, y, z] in document units (each > 0).').optional(),
    height: z
      .number()
      .optional()
      .describe('cylinder / cone height, or the distance between the capsule cap centres, in document units (> 0).'),
    ringRadius: z.number().optional().describe('torus ring (major) radius in document units (> 0).'),
    tubeRadius: z.number().optional().describe('torus tube (minor) radius in document units (> 0, < ringRadius).'),
    normal: vec3('plane normal [x, y, z] (non-zero; normalised for you). The side opposite the normal is inside.').optional(),
    offset: z
      .number()
      .optional()
      .describe('plane offset along the unit normal, in document units: the plane is normal.p = offset. Default 0.'),
    rounding: z
      .number()
      .optional()
      .describe('box edge rounding radius in document units (>= 0, < half the smallest size). Boxes only. Default 0.'),
    position: vec3('Placement [x, y, z] in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Euler XYZ rotation in radians. Default [0, 0, 0].').optional(),
    name: z.string().optional().describe('Optional label for the field node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (message: string, path: string): CommandResult =>
      refuseImplicit(doc, 'add_field_primitive', 'IMP_PARAM_RANGE', message, [], [`params.${path}`]);
    const dims: Record<string, number | readonly [number, number, number]> = {};
    switch (p.shape) {
      case 'sphere':
        if (!positive(p.radius)) return fail(`sphere needs radius > 0 (got ${String(p.radius)})`, 'radius');
        dims['radius'] = p.radius;
        break;
      case 'box':
        if (p.size === undefined || !p.size.every(positive))
          return fail(`box needs size [x, y, z] with every extent > 0 (got ${JSON.stringify(p.size)})`, 'size');
        dims['size'] = p.size;
        if (p.rounding !== undefined && !(p.rounding >= 0 && p.rounding < Math.min(...p.size) / 2))
          return fail(`rounding ${p.rounding} must be >= 0 and below half the smallest size (${Math.min(...p.size) / 2})`, 'rounding');
        break;
      case 'cylinder':
      case 'cone':
        if (!positive(p.radius) || !positive(p.height))
          return fail(
            `${p.shape} needs radius > 0 and height > 0 (got ${String(p.radius)}, ${String(p.height)})`,
            positive(p.radius) ? 'height' : 'radius',
          );
        dims['radius'] = p.radius;
        dims['height'] = p.height;
        break;
      case 'capsule':
        if (!positive(p.radius) || !positive(p.height))
          return fail(
            `capsule needs radius > 0 and height > 0 (got ${String(p.radius)}, ${String(p.height)})`,
            positive(p.radius) ? 'height' : 'radius',
          );
        dims['radius'] = p.radius;
        dims['height'] = p.height;
        break;
      case 'torus':
        if (!positive(p.ringRadius) || !positive(p.tubeRadius) || p.tubeRadius >= p.ringRadius)
          return fail(`torus needs ringRadius > tubeRadius > 0 (got ${String(p.ringRadius)}, ${String(p.tubeRadius)})`, 'tubeRadius');
        dims['ringRadius'] = p.ringRadius;
        dims['tubeRadius'] = p.tubeRadius;
        break;
      case 'plane':
        if (p.normal === undefined || !p.normal.every(Number.isFinite) || Math.hypot(...p.normal) === 0)
          return fail(`plane needs a non-zero finite normal (got ${JSON.stringify(p.normal)})`, 'normal');
        dims['normal'] = p.normal;
        dims['offset'] = p.offset ?? 0;
        break;
    }
    if (p.rounding !== undefined && p.shape !== 'box') return fail('rounding applies to boxes only', 'rounding');
    const node: PrimitiveNode = {
      id: nextId('fld'),
      op: 'primitive',
      shape: p.shape as PrimitiveShape,
      dims,
      position: p.position ?? [0, 0, 0],
      rotation: p.rotation ?? [0, 0, 0],
      ...(p.rounding === undefined || p.rounding === 0 ? {} : { rounding: p.rounding }),
      ...(p.name === undefined ? {} : { name: p.name }),
    };
    return addNode(doc, 'add_field_primitive', node, `${p.shape} primitive at [${node.position.join(', ')}]`, { shape: p.shape });
  },
});
