/** set_explicit_controls / set_initial_velocity / add_rigid_wall / delete_rigid_wall: the set-up of an explicit dynamics case (PHY-19). */

import type { ExplicitMassScaling, ExplicitMeshSource, ExplicitSpec } from '@core/model/explicit';
import type { NamedValue } from '@core/model/topology';
import type { Vec3 } from '@core/model/vectors';
import type { CadDocument } from '@core/model/types';
import type { AnalysisCase } from '@core/model/analysis';
import { defineCommand, z } from '@core/commands/schema';
import { changed, noop } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { refuseExplicit } from './codes';
import { DEFAULT_BULK_LINEAR, DEFAULT_BULK_QUADRATIC, DEFAULT_HOURGLASS_COEFFICIENT, DEFAULT_TIME_STEP_SCALE } from './defaults';
import { explicitCase, supportedUnits, withSpec } from './model';

const timeSchema = z.object({
  value: z.number().describe('Numeric value.'),
  unit: z.string().describe("Time unit, e.g. 's', 'ms', 'us'."),
});
const namedSchema = z.object({
  value: z.number().describe('Numeric value.'),
  source: z.string().min(1).describe('Where the value comes from (company rule, reference); recorded with the value.'),
});
const gravitySchema = z.object({
  vector: z.tuple([z.number(), z.number(), z.number()]).describe('Gravity [x, y, z].'),
  unit: z.string().describe("Acceleration unit, e.g. 'mm/s^2', 'm/s^2'."),
});
const velocitySchema = z.object({
  vector: z.tuple([z.number(), z.number(), z.number()]).describe('Velocity [x, y, z].'),
  unit: z.string().describe("Velocity unit, e.g. 'mm/s', 'm/s'."),
});

type Fail = (code: string, message: string, ids?: readonly string[], paths?: readonly string[]) => CommandResult;

const seconds = (quantity: { value: number; unit: string }): number | null => {
  const converted = convertValue(quantity.value, quantity.unit, 's');
  return isUnitFailure(converted) || !Number.isFinite(converted.value) ? null : converted.value;
};

/** `vector` in the case unit system (`perSecond` 1 = velocity, 2 = acceleration), or null when the unit is not one of that dimension. */
function analysisVector(vector: Vec3, unit: string, length: string, perSecond: 1 | 2): Vec3 | null {
  const target = perSecond === 1 ? `${length}/s` : `${length}/s^2`;
  const component = (value: number): number | null => {
    const converted = convertValue(value, unit, target);
    return isUnitFailure(converted) || !Number.isFinite(converted.value) ? null : converted.value;
  };
  const [x, y, z] = [component(vector[0]), component(vector[1]), component(vector[2])];
  return x === null || y === null || z === null ? null : [x, y, z];
}

const given = (input: { value: number; source: string } | undefined, fallback: () => NamedValue): NamedValue =>
  input === undefined ? fallback() : { value: input.value, source: input.source, defaulted: false };

/**
 * @affects doc.analysis.cases[analysisId].explicit (controls replaced; initial velocities and rigid walls kept)
 * @invariant times stored in seconds, gravity in the case unit system; each defaulted setting is named with its source (AF-31)
 * @failure unknown case -> FEA_ANALYSIS_NOT_FOUND; other type -> EXP_CASE_TYPE; unit system other than N-mm-t-s / N-m-kg-s ->
 *   EXP_UNITS_UNSUPPORTED; end time <= 0 or a bad interval -> EXP_TIME_INVALID; selective mass scaling without its limit ->
 *   EXP_MASS_SCALING_LIMIT_MISSING; a setting out of range -> EXP_PARAM_INVALID (all refusals, unchanged doc)
 */
export const setExplicitControls = defineCommand({
  name: 'set_explicit_controls',
  description:
    'Set the run controls of an explicit_dynamics case (llull_explicit solver: central difference, lumped mass, hex8 one-point with ' +
    'Flanagan-Belytschko hourglass control, tet4): end time, history interval, time-step scale, optional minimum time step, mass scaling, gravity, ' +
    'hourglass and bulk viscosity coefficients and the mesh source. Times are {value, unit}; gravity {vector, unit} (e.g. [0, 0, -9806.65] mm/s^2). ' +
    'Unset coefficients take NAMED defaults (time-step scale 0.9, hourglass 0.1, bulk viscosity 0.06 / 1.5) reported in the summary. mesh: ' +
    'structured_hex {size} (document units, axis-aligned unrotated boxes only) or fea_mesh (the linear tet mesh of fea_mesh). Initial velocities ' +
    'and rigid walls are kept. Next: set_initial_velocity, add_rigid_wall, then the explicit_run transport.',
  params: z.object({
    analysisId: analysisIdSchema,
    endTime: timeSchema.describe('Simulated end time, > 0.'),
    historyInterval: timeSchema.describe('Sampling interval of the energy and rigid-wall histories, 0 < interval <= endTime.'),
    timeStepScale: namedSchema.optional().describe('Multiplier of the stable time step, in (0, 1]. Default 0.9 (named).'),
    minTimeStep: timeSchema.optional().describe('The run ends abnormally when the stable step falls below this.'),
    massScaling: z
      .object({
        mode: z
          .enum(['none', 'selective'])
          .describe('none (default) or selective: raise the density of elements whose step is below the target.'),
        targetTimeStep: timeSchema.optional().describe('selective only: the step every element must reach.'),
        maxAddedMassRatio: z
          .number()
          .optional()
          .describe('selective only, REQUIRED there: largest added mass / model mass allowed (no default).'),
      })
      .optional()
      .describe('Mass scaling; default none.'),
    gravity: gravitySchema.optional().describe('Gravity acceleration {vector, unit}; default none.'),
    hourglassCoefficient: namedSchema.optional().describe('Viscous hourglass coefficient of hex8 in [0, 0.5]. Default 0.1 (named).'),
    bulkViscosity: z
      .object({
        linear: namedSchema.describe('Linear coefficient, >= 0.'),
        quadratic: namedSchema.describe('Quadratic coefficient, >= 0.'),
      })
      .optional()
      .describe('Bulk viscosity coefficients. Default linear 0.06, quadratic 1.5 (named).'),
    mesh: z
      .object({
        kind: z
          .enum(['structured_hex', 'fea_mesh'])
          .describe('structured_hex (llull grid on boxes) or fea_mesh (the case mesh artifact, tet4).'),
        size: z.number().optional().describe('structured_hex only: target element edge, document length units, > 0.'),
      })
      .optional()
      .describe('Mesh source; default fea_mesh.'),
  }),
  run: (doc, params): CommandResult => {
    const fail: Fail = (code, message, ids = [params.analysisId], paths = []) =>
      refuseExplicit(doc, 'set_explicit_controls', code, message, ids, paths);
    const found = explicitCase(doc, params.analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    const units = supportedUnits(analysisCase);
    if (units === null) return fail('EXP_UNITS_UNSUPPORTED', `unit system ${analysisCase.unitSystem} is not supported by llull_explicit`);
    const endTimeS = seconds(params.endTime);
    const historyIntervalS = seconds(params.historyInterval);
    if (endTimeS === null || !(endTimeS > 0)) return fail('EXP_TIME_INVALID', 'endTime must be a time > 0', [], ['endTime']);
    if (historyIntervalS === null || !(historyIntervalS > 0) || historyIntervalS > endTimeS)
      return fail('EXP_TIME_INVALID', 'historyInterval must be a time in (0, endTime]', [], ['historyInterval']);
    const minTimeStepS = params.minTimeStep === undefined ? undefined : seconds(params.minTimeStep);
    if (minTimeStepS === null || (minTimeStepS !== undefined && !(minTimeStepS > 0)))
      return fail('EXP_TIME_INVALID', 'minTimeStep must be a time > 0', [], ['minTimeStep']);
    const scaling = massScalingOf(params.massScaling, fail);
    if ('document' in scaling) return scaling;
    const timeStepScale = given(params.timeStepScale, DEFAULT_TIME_STEP_SCALE);
    const hourglass = given(params.hourglassCoefficient, DEFAULT_HOURGLASS_COEFFICIENT);
    const linear = given(params.bulkViscosity?.linear, DEFAULT_BULK_LINEAR);
    const quadratic = given(params.bulkViscosity?.quadratic, DEFAULT_BULK_QUADRATIC);
    if (!(timeStepScale.value > 0 && timeStepScale.value <= 1))
      return fail('EXP_PARAM_INVALID', `timeStepScale ${timeStepScale.value} must be in (0, 1]`, [], ['timeStepScale']);
    if (!(hourglass.value >= 0 && hourglass.value <= 0.5))
      return fail('EXP_PARAM_INVALID', `hourglassCoefficient ${hourglass.value} must be in [0, 0.5]`, [], ['hourglassCoefficient']);
    if (!(linear.value >= 0 && quadratic.value >= 0 && Number.isFinite(linear.value + quadratic.value)))
      return fail('EXP_PARAM_INVALID', 'bulk viscosity coefficients must be >= 0', [], ['bulkViscosity']);
    const gravity = params.gravity === undefined ? undefined : analysisVector(params.gravity.vector, params.gravity.unit, units.length, 2);
    if (gravity === null)
      return fail('EXP_PARAM_INVALID', `gravity unit '${params.gravity?.unit ?? ''}' is not an acceleration`, [], ['gravity']);
    let mesh: ExplicitMeshSource = { kind: 'fea_mesh' };
    if (params.mesh?.kind === 'structured_hex') {
      const size = params.mesh.size;
      if (size === undefined || !(size > 0) || !Number.isFinite(size))
        return fail('EXP_PARAM_INVALID', 'structured_hex needs size > 0 (document units)', [], ['mesh.size']);
      mesh = { kind: 'structured_hex', size };
    }
    const next: ExplicitSpec = {
      endTimeS,
      historyIntervalS,
      timeStepScale,
      ...(minTimeStepS !== undefined ? { minTimeStepS } : {}),
      massScaling: scaling.value,
      ...(gravity !== undefined ? { gravity } : {}),
      hourglassCoefficient: hourglass,
      bulkViscosity: { linear, quadratic },
      mesh,
      initialVelocities: spec?.initialVelocities ?? {},
      rigidWalls: spec?.rigidWalls ?? {},
      rigidWallOrder: spec?.rigidWallOrder ?? [],
      ...(spec?.failure !== undefined ? { failure: spec.failure } : {}),
      ...(spec?.heating !== undefined ? { heating: spec.heating } : {}),
      ...(spec?.imposedMotions !== undefined
        ? { imposedMotions: spec.imposedMotions, imposedMotionOrder: spec.imposedMotionOrder ?? [] }
        : {}),
      ...(spec?.contacts !== undefined ? { contacts: spec.contacts, contactOrder: spec.contactOrder ?? [] } : {}),
      ...(spec?.shells !== undefined ? { shells: spec.shells } : {}),
      ...(spec?.results !== undefined ? { results: spec.results } : {}),
    };
    const defaults = [timeStepScale, hourglass, linear, quadratic].filter((value) => value.defaulted).length;
    return changed(
      withSpec(doc, analysisCase, next),
      `set_explicit_controls: ${params.analysisId} end ${endTimeS} s, history every ${historyIntervalS} s, time-step scale ${timeStepScale.value}${timeStepScale.defaulted ? ' (default)' : ''}, hourglass ${hourglass.value}${hourglass.defaulted ? ' (default)' : ''}, bulk viscosity ${linear.value} / ${quadratic.value}${linear.defaulted || quadratic.defaulted ? ' (default)' : ''}, mass scaling ${scaling.value.mode}, gravity ${gravity === undefined ? 'none' : `[${gravity.join(', ')}] ${units.length}/s^2`}, mesh ${mesh.kind === 'structured_hex' ? `structured_hex ${mesh.size} ${doc.units}` : 'fea_mesh'}; ${defaults} named default(s).`,
      [params.analysisId],
    );
  },
});

function massScalingOf(
  input:
    | { mode: 'none' | 'selective'; targetTimeStep?: { value: number; unit: string } | undefined; maxAddedMassRatio?: number | undefined }
    | undefined,
  fail: Fail,
): { readonly value: ExplicitMassScaling } | CommandResult {
  if (input === undefined || input.mode === 'none') return { value: { mode: 'none' } };
  if (input.targetTimeStep === undefined || input.maxAddedMassRatio === undefined)
    return fail('EXP_MASS_SCALING_LIMIT_MISSING', 'selective mass scaling needs targetTimeStep and maxAddedMassRatio', [], ['massScaling']);
  const target = seconds(input.targetTimeStep);
  if (target === null || !(target > 0))
    return fail('EXP_TIME_INVALID', 'targetTimeStep must be a time > 0', [], ['massScaling.targetTimeStep']);
  if (!(input.maxAddedMassRatio >= 0) || !Number.isFinite(input.maxAddedMassRatio))
    return fail('EXP_PARAM_INVALID', 'maxAddedMassRatio must be >= 0', [], ['massScaling.maxAddedMassRatio']);
  return { value: { mode: 'selective', targetTimeStepS: target, maxAddedMassRatio: input.maxAddedMassRatio } };
}

/** The case and its spec, or the refusal of a command that needs set_explicit_controls first. */
function requireSpec(
  doc: CadDocument,
  analysisId: string,
  fail: Fail,
): CommandResult | { readonly analysisCase: AnalysisCase; readonly spec: ExplicitSpec } {
  const found = explicitCase(doc, analysisId);
  if ('code' in found) return fail(found.code, found.message);
  if (found.spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
  return { analysisCase: found.analysisCase, spec: found.spec };
}

/**
 * @affects doc.analysis.cases[analysisId].explicit.initialVelocities (sets the velocity of one part; a zero vector removes it)
 * @invariant stored in the case unit system (mm/s for N-mm-t-s); ids `iv-<step>.<k>`, one entry per part (replaced in place)
 * @failure unknown / non-explicit case -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE; no controls -> EXP_CONTROLS_MISSING; part not in the case ->
 *   EXP_TARGET_NOT_IN_CASE; unit not a velocity -> EXP_PARAM_INVALID
 */
export const setInitialVelocity = defineCommand({
  name: 'set_initial_velocity',
  description:
    'Give every node of a part of an explicit_dynamics case an initial velocity {vector, unit} (e.g. [0, 0, -10000] mm/s). One velocity per part; ' +
    'calling again replaces it and a zero vector removes it. The part must be in the case (set_part_idealization).',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z.string().describe('Id of a part of the case.'),
    velocity: velocitySchema.describe('Initial velocity {vector, unit}.'),
  }),
  run: (doc, { analysisId, entityId, velocity }): CommandResult => {
    const fail: Fail = (code, message, ids = [analysisId], paths = []) =>
      refuseExplicit(doc, 'set_initial_velocity', code, message, ids, paths);
    const found = requireSpec(doc, analysisId, fail);
    if ('document' in found) return found;
    const { analysisCase, spec } = found;
    if (!Object.hasOwn(analysisCase.parts, entityId))
      return fail('EXP_TARGET_NOT_IN_CASE', `'${entityId}' is not a part of '${analysisId}'`, [entityId], ['entityId']);
    const units = supportedUnits(analysisCase);
    const vector = units === null ? null : analysisVector(velocity.vector, velocity.unit, units.length, 1);
    if (vector === null || units === null)
      return fail('EXP_PARAM_INVALID', `'${velocity.unit}' is not a velocity unit`, [], ['velocity.unit']);
    const existing = Object.entries(spec.initialVelocities).find(([, entry]) => entry.entityId === entityId)?.[0];
    const rest = Object.fromEntries(Object.entries(spec.initialVelocities).filter(([id]) => id !== existing));
    const zero = vector.every((component) => component === 0);
    if (zero && existing === undefined)
      return noop(doc, `set_initial_velocity: ${entityId} already has no initial velocity in ${analysisId}.`);
    const id = existing ?? nextId('iv');
    const initialVelocities = zero ? rest : { ...spec.initialVelocities, [id]: { entityId, velocity: vector } };
    return changed(
      withSpec(doc, analysisCase, { ...spec, initialVelocities }),
      zero
        ? `set_initial_velocity: ${entityId} has no initial velocity in ${analysisId}.`
        : `set_initial_velocity: ${entityId} starts at [${vector.join(', ')}] ${units.length}/s in ${analysisId} (${id}).`,
      [analysisId],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].explicit.rigidWalls (adds 1 wall; affected: [analysisId, wallId])
 * @invariant ids `rw-<step>.<k>`; point in document units; the normal points into the half space the model lives in; frictionless (V1)
 * @failure no controls -> EXP_CONTROLS_MISSING; zero normal or duplicate name -> EXP_RIGID_WALL_INVALID
 */
export const addRigidWall = defineCommand({
  name: 'add_rigid_wall',
  description:
    'Add a fixed, frictionless planar rigid wall to an explicit_dynamics case: `point` on the plane (document units) and `normal` pointing toward ' +
    'the model. Nodes are not allowed to cross the plane; the wall force history is reported by explicit_report. Returns the wall id in affected[1].',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique wall name, e.g. "anvil".'),
    point: z.tuple([z.number(), z.number(), z.number()]).describe('A point of the plane [x, y, z], document units.'),
    normal: z.tuple([z.number(), z.number(), z.number()]).describe('Plane normal toward the model, non-zero.'),
  }),
  run: (doc, { analysisId, name, point, normal }): CommandResult => {
    const fail: Fail = (code, message, ids = [analysisId], paths = []) => refuseExplicit(doc, 'add_rigid_wall', code, message, ids, paths);
    const found = requireSpec(doc, analysisId, fail);
    if ('document' in found) return found;
    const { analysisCase, spec } = found;
    const length = Math.hypot(...normal);
    if (!(length > 0) || !Number.isFinite(length) || !point.every(Number.isFinite))
      return fail('EXP_RIGID_WALL_INVALID', 'the wall needs a finite point and a non-zero normal', [], ['normal']);
    if (Object.values(spec.rigidWalls).some((wall) => wall.name === name))
      return fail('EXP_RIGID_WALL_INVALID', `a wall named '${name}' exists already`, [], ['name']);
    const id = nextId('rw');
    const next: ExplicitSpec = {
      ...spec,
      rigidWalls: { ...spec.rigidWalls, [id]: { name, point, normal } },
      rigidWallOrder: [...spec.rigidWallOrder, id],
    };
    return changed(
      withSpec(doc, analysisCase, next),
      `add_rigid_wall: ${id} '${name}' through [${point.join(', ')}] ${doc.units}, normal [${normal.join(', ')}] in ${analysisId}.`,
      [analysisId, id],
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].explicit.rigidWalls (removes 1 wall)
 * @failure no controls -> EXP_CONTROLS_MISSING; unknown wall -> EXP_RIGID_WALL_NOT_FOUND
 */
export const deleteRigidWall = defineCommand({
  name: 'delete_rigid_wall',
  description: 'Remove a rigid wall (by id, affected[1] of add_rigid_wall) from an explicit_dynamics case.',
  params: z.object({ analysisId: analysisIdSchema, wallId: z.string().describe('Wall id, e.g. rw-12.1.') }),
  run: (doc, { analysisId, wallId }): CommandResult => {
    const fail: Fail = (code, message, ids = [analysisId], paths = []) =>
      refuseExplicit(doc, 'delete_rigid_wall', code, message, ids, paths);
    const found = requireSpec(doc, analysisId, fail);
    if ('document' in found) return found;
    const { analysisCase, spec } = found;
    if (!Object.hasOwn(spec.rigidWalls, wallId))
      return fail('EXP_RIGID_WALL_NOT_FOUND', `no wall '${wallId}' in '${analysisId}'`, [wallId]);
    const rigidWalls = Object.fromEntries(Object.entries(spec.rigidWalls).filter(([id]) => id !== wallId));
    return changed(
      withSpec(doc, analysisCase, { ...spec, rigidWalls, rigidWallOrder: spec.rigidWallOrder.filter((id) => id !== wallId) }),
      `delete_rigid_wall: ${wallId} removed from ${analysisId}.`,
      [analysisId],
    );
  },
});
