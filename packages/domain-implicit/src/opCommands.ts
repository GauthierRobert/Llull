/** Field operators: combine_fields (sharp and smooth booleans), offset_field, shell_field, transform_field (05 IMP 4.1, 5.3). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { type BooleanNode, type FieldNode, fieldOf } from './model';
import { addNode } from './nodeResult';

const MAX_OPERANDS = 256;

/** Id of the first of `ids` that is not a field node, or undefined. */
const missingField = (doc: CadDocument, ids: readonly string[]): string | undefined => ids.find((id) => fieldOf(doc, id) === undefined);

/** Blend facts in field units (5.3): the largest deviation from the sharp min, and how far the surface is moved off each face. */
function blendMetrics(kind: 'quadratic' | 'exponential' | 'chamfer', k: number): Record<string, number> {
  switch (kind) {
    case 'quadratic':
      return { setback: k, maxDeviation: k / 4, bisectorDistance: k / 4, addedAreaPerLengthOrthogonal: (k * k) / 6 };
    case 'exponential':
      return { maxDeviation: k * Math.LN2, setback99: 4.6 * k };
    case 'chamfer':
      return { setback: k, maxDeviation: k * Math.SQRT1_2 };
  }
}

/**
 * @affects creates 1 boolean field node over the operands (a first, then b)
 * @invariant union / intersect / subtract are min / max / max(a, -b) of the distances; a blend rounds the junction by a parabolic (quadratic), exponential or 45-degree (chamfer) transition whose setback and deviation are reported
 * @failure unknown operand -> IMP_FIELD_NOT_FOUND; blend radius <= 0 or fewer than 2 operands -> IMP_PARAM_RANGE
 */
export const combineFields = defineCommand({
  name: 'combine_fields',
  description:
    'Boolean of implicit FIELD nodes (never fails geometrically, unlike B-rep booleans): union, intersect, or subtract (a minus every b). ' +
    'Optional blend turns the sharp junction into a smooth one: quadratic (parabolic arc that leaves each face at distance radius from the edge, deviation radius/4 on the bisector), ' +
    'exponential (deviation radius*ln2, tails up to ~4.6*radius) or chamfer (45-degree flat, setback radius). The reply data.blend gives setback and maxDeviation in document units. ' +
    'Sharp results are distance bounds (not exact); a blended result is also a bound. Next: create_implicit_body.',
  params: z.object({
    op: z.enum(['union', 'intersect', 'subtract']).describe('Boolean kind. subtract removes every b from a.'),
    a: z.string().describe('Id of the first field (the kept one for subtract).'),
    b: z
      .union([z.string(), z.array(z.string()).max(MAX_OPERANDS)])
      .describe(`Id of the second field, or a list of up to ${MAX_OPERANDS} ids.`),
    blend: z
      .object({
        kind: z.enum(['quadratic', 'exponential', 'chamfer']).describe('Blend law.'),
        radius: z.number().describe('Blend radius k in document units (> 0): the setback of the transition from each face.'),
      })
      .optional()
      .describe('Smooth the junction. Omit for a sharp boolean.'),
    name: z.string().optional().describe('Optional label for the result node.'),
  }),
  run: (doc, { op, a, b, blend, name }): CommandResult => {
    const operands = [a, ...(Array.isArray(b) ? b : [b])];
    const absent = missingField(doc, operands);
    if (absent !== undefined)
      return refuseImplicit(
        doc,
        'combine_fields',
        'IMP_FIELD_NOT_FOUND',
        `no field '${absent}'`,
        [absent],
        [absent === a ? 'params.a' : 'params.b'],
      );
    if (operands.length < 2)
      return refuseImplicit(doc, 'combine_fields', 'IMP_PARAM_RANGE', 'a boolean needs at least two fields', [], ['params.b']);
    if (blend !== undefined && !(Number.isFinite(blend.radius) && blend.radius > 0))
      return refuseImplicit(
        doc,
        'combine_fields',
        'IMP_PARAM_RANGE',
        `blend radius must be > 0 (got ${blend.radius})`,
        [],
        ['params.blend.radius'],
      );
    const node: BooleanNode = {
      id: nextId('fld'),
      op: 'boolean',
      kind: op,
      operands,
      ...(blend === undefined ? {} : { blend }),
      ...(name === undefined ? {} : { name }),
    };
    const extra: Record<string, unknown> = {};
    const warnings: Array<{ code: string; ids: string[]; message: string }> = [];
    if (blend !== undefined) {
      extra['blend'] = { kind: blend.kind, radius: blend.radius, ...blendMetrics(blend.kind, blend.radius) };
      const features = operands.map((id) => compileField(doc, id)).flatMap((c) => (c.ok ? [c.minFeature] : []));
      const smallest = Math.min(...features);
      if (blend.radius > smallest)
        warnings.push({
          code: 'IMP_BLEND_EXCEEDS_FEATURE',
          ids: [node.id],
          message: `blend radius ${blend.radius} exceeds the smallest known feature radius ${smallest} of the operands`,
        });
    }
    const result = addNode(
      doc,
      'combine_fields',
      node,
      `${op} of ${operands.join(', ')}${blend === undefined ? '' : ` with ${blend.kind} blend ${blend.radius}`}`,
      extra,
    );
    if (warnings.length === 0 || result.data === undefined) return result;
    const data = result.data as { warnings: unknown[] };
    return {
      ...result,
      data: { ...data, warnings: [...data.warnings, ...warnings] },
      summary: `${result.summary} Warnings: ${warnings.map((w) => w.code).join(', ')}.`,
    };
  },
});

function oneSource(doc: CadDocument, command: string, field: string): CommandResult | null {
  return fieldOf(doc, field) === undefined
    ? refuseImplicit(doc, command, 'IMP_FIELD_NOT_FOUND', `no field '${field}'`, [field], ['params.field'])
    : null;
}

/**
 * @affects creates 1 offset node
 * @invariant f - distance: exact on exact sources; on a bound / approximate source the result carries IMP_OFFSET_NOT_EXACT
 * @failure unknown field -> IMP_FIELD_NOT_FOUND; non-finite distance -> IMP_PARAM_RANGE
 */
export const offsetField = defineCommand({
  name: 'offset_field',
  description:
    'Grow (distance > 0) or shrink (distance < 0) an implicit FIELD by a distance in document units: the iso-surface moves outward by `distance`. Exact when the source field is exact ' +
    '(primitive, transform or field_from_solid of one); on blended / booleaned / lattice sources the surface is not the true offset and the reply carries warning IMP_OFFSET_NOT_EXACT.',
  params: z.object({
    field: z.string().describe('Id of the field to offset.'),
    distance: z.number().describe('Offset distance in document units; positive grows the body, negative shrinks it.'),
    name: z.string().optional().describe('Optional label for the result node.'),
  }),
  run: (doc, { field, distance, name }): CommandResult => {
    const missing = oneSource(doc, 'offset_field', field);
    if (missing !== null) return missing;
    if (!Number.isFinite(distance))
      return refuseImplicit(doc, 'offset_field', 'IMP_PARAM_RANGE', 'distance must be a finite number', [], ['params.distance']);
    const node: FieldNode = { id: nextId('fld'), op: 'offset', source: field, distance, ...(name === undefined ? {} : { name }) };
    return addNode(doc, 'offset_field', node, `offset of ${field} by ${distance}`);
  },
});

/**
 * @affects creates 1 shell node
 * @invariant inside: max(f, -f - t); outside: max(-f, f - t); centred: |f| - t/2 (wall thickness t, exact on exact sources)
 * @failure unknown field -> IMP_FIELD_NOT_FOUND; thickness <= 0 -> IMP_PARAM_RANGE
 */
export const shellField = defineCommand({
  name: 'shell_field',
  description:
    'Hollow an implicit FIELD into a wall of constant thickness (document units): inside keeps the wall within the surface, outside builds it around, centred straddles the surface. ' +
    'Never fails for thin features (unlike shell_solid). Exact on exact sources; otherwise warning IMP_OFFSET_NOT_EXACT. Combine with a lattice for infill (union of skin and lattice).',
  params: z.object({
    field: z.string().describe('Id of the field to hollow.'),
    thickness: z.number().describe('Wall thickness in document units (> 0).'),
    side: z
      .enum(['inside', 'outside', 'centred'])
      .optional()
      .describe('Which side of the original surface the wall occupies. Default inside.'),
    name: z.string().optional().describe('Optional label for the result node.'),
  }),
  run: (doc, { field, thickness, side = 'inside', name }): CommandResult => {
    const missing = oneSource(doc, 'shell_field', field);
    if (missing !== null) return missing;
    if (!(Number.isFinite(thickness) && thickness > 0))
      return refuseImplicit(doc, 'shell_field', 'IMP_PARAM_RANGE', `thickness must be > 0 (got ${thickness})`, [], ['params.thickness']);
    const node: FieldNode = { id: nextId('fld'), op: 'shell', source: field, thickness, side, ...(name === undefined ? {} : { name }) };
    return addNode(doc, 'shell_field', node, `${side} shell of ${field}, wall ${thickness}`);
  },
});

/**
 * @affects creates 1 transform node
 * @invariant local = R^T (p - position) / scale and f = scale * f_source(local): rigid and uniform-scale transforms keep the distance quality
 * @failure unknown field -> IMP_FIELD_NOT_FOUND; scale <= 0 -> IMP_PARAM_RANGE
 */
export const transformField = defineCommand({
  name: 'transform_field',
  description:
    'Move, rotate and uniformly scale an implicit FIELD as a new node (the source stays). The source is scaled about its own origin, rotated (Euler XYZ, radians) then translated by position. ' +
    'Rigid and uniform-scale transforms keep the distance exact; a sphere of radius 5 scaled by 2 equals a sphere of radius 10.',
  params: z.object({
    field: z.string().describe('Id of the field to transform.'),
    position: vec3('Translation [x, y, z] in document units. Default [0, 0, 0].').optional(),
    rotation: vec3('Euler XYZ rotation in radians. Default [0, 0, 0].').optional(),
    scale: z.number().optional().describe('Uniform scale factor (> 0). Default 1.'),
    name: z.string().optional().describe('Optional label for the result node.'),
  }),
  run: (doc, { field, position, rotation, scale = 1, name }): CommandResult => {
    const missing = oneSource(doc, 'transform_field', field);
    if (missing !== null) return missing;
    if (!(Number.isFinite(scale) && scale > 0))
      return refuseImplicit(doc, 'transform_field', 'IMP_PARAM_RANGE', `scale must be > 0 (got ${scale})`, [], ['params.scale']);
    const node: FieldNode = {
      id: nextId('fld'),
      op: 'transform',
      source: field,
      position: position ?? [0, 0, 0],
      rotation: rotation ?? [0, 0, 0],
      scale,
      ...(name === undefined ? {} : { name }),
    };
    return addNode(doc, 'transform_field', node, `transform of ${field} (scale ${scale})`);
  },
});
