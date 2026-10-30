/** create_scalar_field: a scalar field (law) as a node, for graded thickness / radius / offset / blend radius (05 IMP 4.1, FR-IMP-16). */

import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseImplicit } from './codes';
import { compileScalarField } from './compile';
import { type DistanceTarget, type FieldNode, type Law, type ScalarNode, fieldOf, withField } from './model';
import { closedSolidMesh } from './solidMesh';

const lawSchema = z.union([z.number(), z.string()]);

const isScalar = (doc: Parameters<typeof fieldOf>[0], id: string): boolean => fieldOf(doc, id)?.op === 'scalar';

/** The first problem of a node's references, or null. */
function referenceProblem(
  doc: Parameters<typeof fieldOf>[0],
  node: ScalarNode,
): { code: string; message: string; ids: string[]; path: string } | null {
  const lawProblem = (law: Law | undefined, path: string): { code: string; message: string; ids: string[]; path: string } | null => {
    if (typeof law !== 'string') return null;
    if (fieldOf(doc, law) === undefined) return { code: 'IMP_FIELD_NOT_FOUND', message: `no scalar field '${law}'`, ids: [law], path };
    return isScalar(doc, law) ? null : { code: 'IMP_PARAM_RANGE', message: `'${law}' is not a scalar field (a law)`, ids: [law], path };
  };
  switch (node.kind) {
    case 'ramp':
      return lawProblem(node.input, 'input');
    case 'mix':
      return lawProblem(node.a, 'a') ?? lawProblem(node.b, 'b') ?? lawProblem(node.factor, 'factor');
    case 'arith':
      return lawProblem(node.a, 'a') ?? lawProblem(node.b, 'b');
    default:
      return null;
  }
}

/**
 * @affects creates 1 scalar node `fld-<step>.<k>` (no geometry; used as a law by add_tpms_lattice, add_strut_lattice, shell_field, offset_field, combine_fields)
 * @invariant a scalar is a function of the point; noise is deterministic (counter hash of the seed, no sin), identical on every engine; data.range is the guaranteed range when known
 * @failure unknown field / entity -> IMP_FIELD_NOT_FOUND / IMP_ENTITY_NOT_FOUND; input is not a scalar, inMin = inMax, bad plane, bad noise parameters -> IMP_PARAM_RANGE; open solid -> IMP_SOLID_NOT_CLOSED
 */
export const createScalarField = defineCommand({
  name: 'create_scalar_field',
  annotations: { readsMeshTriangles: true },
  description:
    'Create a SCALAR field (a number at every point of space) to grade a lattice: pass its id as thickness / level (add_tpms_lattice), radius (add_strut_lattice), thickness (shell_field), distance (offset_field) or blend radius (combine_fields) instead of a number. ' +
    'kind coordinate: the x, y or z coordinate (axis). kind distance: distance in document units to a point (toPoint), a plane (toPlane, signed, positive on the normal side), the closed solid of an entity (toEntity, signed, negative inside) or the value of another field (toField); give exactly one. ' +
    'kind ramp: maps an input scalar (input) from [inMin, inMax] to [outMin, outMax], clamped by default, easing linear or smoothstep (the nTop "ramp"). kind mix: a*(1-factor) + b*factor. kind arith: add, subtract, multiply, divide, min or max of a and b. ' +
    'kind noise: deterministic value noise in [0, 1) from seed, frequency (cells per document unit) and octaves 1..6. a, b, factor accept a number or a scalar field id. ' +
    'kind topology_density: the recorded density (0..1) of a topology study (studyId), trilinear between voxel centres and the nearest voxel outside the design grid; grade a lattice by the recorded design (ramp it to a radius or thickness). ' +
    'kind fea_result: a result of an analysis case (caseId) on its tetrahedral mesh: quantity von_mises (stress, in the analysis stress unit) or u_mag (displacement magnitude, in the analysis length unit), barycentric inside the tetrahedra and the nearest node outside, from solver step `step` (load case index + 1; default the first step with the field). ' +
    'Both read the recorded result, so re-recording the result makes the bodies built on the field stale (regenerate_implicit_bodies). Refused with IMP_INPUT_NOT_FOUND when the study or case has no verified result or the host holds no artifact store. ' +
    'Next: add_tpms_lattice / add_strut_lattice with the id as the graded value; evaluate_field does not take scalars (probe them through the lattice).',
  params: z.object({
    kind: z
      .enum(['coordinate', 'distance', 'ramp', 'mix', 'arith', 'noise', 'topology_density', 'fea_result'])
      .describe('Scalar kind; see the command description for the parameters of each.'),
    axis: z.enum(['x', 'y', 'z']).optional().describe('coordinate: which coordinate.'),
    toPoint: vec3('distance: measure to this point [x, y, z] in document units.').optional(),
    toPlane: z
      .object({
        origin: vec3('A point on the plane [x, y, z].'),
        normal: vec3('Plane normal [x, y, z] (non-zero); positive on this side.'),
      })
      .optional()
      .describe('distance: signed distance to this plane.'),
    toEntity: z.string().optional().describe('distance: signed distance to the closed 3D solid with this entity id (negative inside).'),
    toField: z.string().optional().describe('distance: the value of this field node (e.g. a body field) as the scalar.'),
    input: z.string().optional().describe('ramp: id of the input scalar field.'),
    inMin: z.number().optional().describe('ramp: input value that maps to outMin.'),
    inMax: z.number().optional().describe('ramp: input value that maps to outMax (must differ from inMin).'),
    outMin: z.number().optional().describe('ramp: output value at inMin.'),
    outMax: z.number().optional().describe('ramp: output value at inMax.'),
    clamp: z
      .boolean()
      .optional()
      .describe('ramp: hold the output at its ends outside [inMin, inMax]. Default true (required for smoothstep).'),
    easing: z.enum(['linear', 'smoothstep']).optional().describe('ramp: linear (default) or smoothstep.'),
    a: lawSchema.optional().describe('mix / arith: first operand, a number or a scalar field id.'),
    b: lawSchema.optional().describe('mix / arith: second operand, a number or a scalar field id.'),
    factor: lawSchema.optional().describe('mix: blend factor (0 gives a, 1 gives b), a number or a scalar field id.'),
    operation: z.enum(['add', 'subtract', 'multiply', 'divide', 'min', 'max']).optional().describe('arith: the operation on a and b.'),
    seed: z.number().optional().describe('noise: integer seed (default 0); the same seed gives the same field.'),
    frequency: z.number().optional().describe('noise: noise cells per document unit (> 0).'),
    octaves: z.number().optional().describe('noise: octaves 1..6 (default 1); each doubles the frequency and halves the amplitude.'),
    studyId: z.string().optional().describe('topology_density: id of the topology study whose recorded density is read.'),
    caseId: z.string().optional().describe('fea_result: id of the analysis case whose results and mesh are read.'),
    quantity: z.enum(['von_mises', 'u_mag']).optional().describe('fea_result: von_mises (stress) or u_mag (displacement magnitude).'),
    step: z
      .number()
      .optional()
      .describe('fea_result: solver step number (load case index + 1); default the lowest step that holds the field.'),
    name: z.string().optional().describe('Optional label for the node.'),
  }),
  run: (doc, p): CommandResult => {
    const fail = (code: string, message: string, path: string, ids: string[] = []): CommandResult =>
      refuseImplicit(doc, 'create_scalar_field', code, message, ids, [`params.${path}`]);
    const id = nextId('fld');
    const label = p.name === undefined ? {} : { name: p.name };
    let node: ScalarNode;
    switch (p.kind) {
      case 'coordinate':
        if (p.axis === undefined) return fail('IMP_PARAM_RANGE', 'coordinate needs axis x, y or z', 'axis');
        node = { id, op: 'scalar', kind: 'coordinate', axis: p.axis, ...label };
        break;
      case 'distance': {
        const targets = [p.toPoint, p.toPlane, p.toEntity, p.toField].filter((t) => t !== undefined).length;
        if (targets !== 1)
          return fail(
            'IMP_PARAM_CONFLICT',
            `distance needs exactly one of toPoint, toPlane, toEntity, toField (got ${targets})`,
            'toPoint',
          );
        let to: DistanceTarget;
        if (p.toPoint !== undefined) to = { point: p.toPoint };
        else if (p.toPlane !== undefined) {
          if (!(Math.hypot(...p.toPlane.normal) > 0)) return fail('IMP_PARAM_RANGE', 'toPlane.normal must be non-zero', 'toPlane.normal');
          to = { plane: p.toPlane };
        } else if (p.toEntity !== undefined) {
          const solid = closedSolidMesh(doc, p.toEntity);
          if (!solid.ok) return fail(solid.code, solid.message, 'toEntity', [p.toEntity]);
          to = { entityId: p.toEntity };
        } else {
          const field = p.toField as string;
          if (fieldOf(doc, field) === undefined) return fail('IMP_FIELD_NOT_FOUND', `no field '${field}'`, 'toField', [field]);
          to = { field };
        }
        node = { id, op: 'scalar', kind: 'distance', to, ...label };
        break;
      }
      case 'ramp': {
        const { input, inMin, inMax, outMin, outMax } = p;
        if (input === undefined || inMin === undefined || inMax === undefined || outMin === undefined || outMax === undefined)
          return fail('IMP_PARAM_RANGE', 'ramp needs input, inMin, inMax, outMin and outMax', 'input');
        if (![inMin, inMax, outMin, outMax].every(Number.isFinite) || inMin === inMax)
          return fail('IMP_PARAM_RANGE', `ramp needs finite values and inMin != inMax (got ${inMin}, ${inMax})`, 'inMax');
        if (p.clamp === false && p.easing === 'smoothstep')
          return fail('IMP_PARAM_RANGE', 'smoothstep needs clamp (it is defined on [0, 1])', 'clamp');
        node = {
          id,
          op: 'scalar',
          kind: 'ramp',
          input,
          inMin,
          inMax,
          outMin,
          outMax,
          clamp: p.clamp ?? true,
          easing: p.easing ?? 'linear',
          ...label,
        };
        break;
      }
      case 'mix':
        if (p.a === undefined || p.b === undefined || p.factor === undefined)
          return fail('IMP_PARAM_RANGE', 'mix needs a, b and factor', 'factor');
        node = { id, op: 'scalar', kind: 'mix', a: p.a, b: p.b, factor: p.factor, ...label };
        break;
      case 'arith':
        if (p.a === undefined || p.b === undefined || p.operation === undefined)
          return fail('IMP_PARAM_RANGE', 'arith needs operation, a and b', 'operation');
        node = { id, op: 'scalar', kind: 'arith', operation: p.operation, a: p.a, b: p.b, ...label };
        break;
      case 'topology_density':
        if (p.studyId === undefined) return fail('IMP_PARAM_RANGE', 'topology_density needs studyId', 'studyId');
        node = { id, op: 'scalar', kind: 'topology_density', studyId: p.studyId, ...label };
        break;
      case 'fea_result':
        if (p.caseId === undefined || p.quantity === undefined)
          return fail('IMP_PARAM_RANGE', 'fea_result needs caseId and quantity (von_mises or u_mag)', 'caseId');
        if (p.step !== undefined && !(Number.isInteger(p.step) && p.step >= 1))
          return fail('IMP_PARAM_RANGE', `step must be an integer >= 1 (got ${p.step})`, 'step');
        node = {
          id,
          op: 'scalar',
          kind: 'fea_result',
          caseId: p.caseId,
          quantity: p.quantity,
          ...(p.step === undefined ? {} : { step: p.step }),
          ...label,
        };
        break;
      case 'noise': {
        const octaves = p.octaves ?? 1;
        if (!(p.frequency !== undefined && Number.isFinite(p.frequency) && p.frequency > 0))
          return fail('IMP_PARAM_RANGE', `noise needs frequency > 0 (got ${String(p.frequency)})`, 'frequency');
        if (!(Number.isInteger(octaves) && octaves >= 1 && octaves <= 6))
          return fail('IMP_PARAM_RANGE', `octaves must be an integer 1..6 (got ${octaves})`, 'octaves');
        if (p.seed !== undefined && !Number.isInteger(p.seed))
          return fail('IMP_PARAM_RANGE', `seed must be an integer (got ${p.seed})`, 'seed');
        node = { id, op: 'scalar', kind: 'noise', seed: p.seed ?? 0, frequency: p.frequency, octaves, ...label };
        break;
      }
    }
    const problem = referenceProblem(doc, node);
    if (problem !== null) return fail(problem.code, problem.message, problem.path, problem.ids);
    const next = withField(doc, node as FieldNode);
    const compiled = compileScalarField(next, id);
    if (!compiled.ok) return refuseImplicit(doc, 'create_scalar_field', compiled.code, compiled.message, compiled.ids);
    const range = compiled.scalarRange ?? null;
    return {
      document: next,
      summary: `create_scalar_field: ${p.kind} scalar -> field ${id} (${range === null || !Number.isFinite(range.lo) ? 'range unbounded' : `range [${range.lo}, ${range.hi}]`}). Next: pass id=${id} as a graded value (thickness, level, radius, distance, blend radius).`,
      affected: [id],
      data: {
        id,
        op: 'scalar',
        kind: p.kind,
        range:
          range === null ? null : { min: Number.isFinite(range.lo) ? range.lo : null, max: Number.isFinite(range.hi) ? range.hi : null },
        rangeKind: 'guaranteed bounds where known (null = unbounded)',
        unit: doc.units,
        unverified: compiled.unverified,
      },
    };
  },
});
