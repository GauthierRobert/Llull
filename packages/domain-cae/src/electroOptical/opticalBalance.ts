/** optical_balance (PHY-15 FR-EOP-08, TR-EOP-30): equilibrium temperature of a sun-facing plate from its coating's alpha and epsilon. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import type { CadDocument } from '@core/model/types';
import { refuseEop } from './codes';
import { electroOpticalOf } from './model';
import { type Missing, type Value, isMissing, propertyOf } from './opticalProperty';
import { STEFAN_BOLTZMANN, equilibriumTemperature } from './physics';

const COMMAND = 'optical_balance';
const MAX_ITERATIONS = 200;
const TOLERANCE_K = 1e-9;

interface Solved {
  readonly eps: Value;
  /** The self-consistent temperature of a T-dependent emissivity, null for a constant one. */
  readonly temperature: number | null;
  readonly iterations: number;
}

/** The emissivity record at the equilibrium temperature: a constant model directly, a T-dependent one by fixed-point iteration (refused when it does not settle). */
function solveEmissivity(
  doc: CadDocument,
  material: string,
  alpha: number,
  fluxW: number,
  incidenceRad: number,
  faces: 1 | 2,
  ctx: ExecutionContext | undefined,
): Solved | Missing {
  const condition = { opticalKind: 'hemispherical_total' };
  const direct = propertyOf(doc, material, 'emissivityIr', condition, {}, ctx);
  if (!isMissing(direct)) return { eps: direct, temperature: null, iterations: 0 };
  const unavailable = (why: string): Missing => ({
    code: 'EOP_SURFACE_PROPERTY_MISSING',
    message: `emissivityIr (hemispherical_total) unavailable: ${why}`,
  });
  if (direct.code !== 'PROP_VARIABLE_MISSING') return unavailable(direct.message);
  if (alpha === 0)
    return {
      code: 'EOP_BALANCE_DEGENERATE',
      message:
        'alpha = 0 absorbs nothing (T = 0 K), outside every temperature-dependent emissivity model: give a constant emissivity or alpha > 0',
    };
  let current = equilibriumTemperature(alpha, fluxW, incidenceRad, 0.5, faces);
  let delta = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= MAX_ITERATIONS; step += 1) {
    const found = propertyOf(doc, material, 'emissivityIr', condition, { T: { value: current, unit: 'K' } }, ctx);
    if (isMissing(found)) return unavailable(`${found.message} (iteration ${step} at ${current} K)`);
    const next = equilibriumTemperature(alpha, fluxW, incidenceRad, found.value, faces);
    delta = Math.abs(next - current);
    current = next;
    if (delta < TOLERANCE_K) return { eps: found, temperature: current, iterations: step };
  }
  return {
    code: 'EOP_BALANCE_NOT_CONVERGED',
    message: `the temperature-dependent emissivity did not settle after ${MAX_ITERATIONS} iterations (last T ${current} K, last change ${delta} K): the balance may have no stable solution`,
  };
}

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant T = (alpha S cos(theta) / (n eps sigma))^(1/4) with sigma from the exact SI constants; alpha at the requested BOL / EOL state (default BOL, reported as defaulted), eps hemispherical total (a temperature-dependent
 *   model is solved by fixed-point iteration); never a default solar flux, alpha or epsilon; caller-supplied alpha / eps are reported unverified; flat plate, no conduction, albedo or planet IR
 * @failure no flux -> EOP_SOLAR_FLUX_MISSING; flux not positive or a bad incidence angle -> EOP_PARAMS_INVALID; no coating or value -> EOP_COATING_NOT_ASSIGNED / EOP_COATING_AMBIGUOUS / EOP_COATING_NOT_FOUND / EOP_SURFACE_PROPERTY_MISSING;
 *   alpha outside [0, 1] or epsilon outside (0, 1] -> EOP_PROPERTY_RANGE; a T-dependent emissivity that does not settle in 200 iterations -> EOP_BALANCE_NOT_CONVERGED (last T and change named), alpha = 0 with a T-dependent emissivity -> EOP_BALANCE_DEGENERATE (T = 0 K is outside every model; refused, not answered) (all refusals, unchanged doc)
 */
export const opticalBalance = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true },
  description:
    'Equilibrium temperature of a sun-facing flat plate: alpha S cos(theta) = n eps sigma T^4, n = radiatingFaces (1 = insulated back, 2 = thin plate), sigma from the exact SI constants. ' +
    "alpha and eps come from the coating: pass coating (a material with absorptivitySolar [condition lifeState BOL|EOL] and emissivityIr [condition opticalKind hemispherical_total] PHY-01 models) or entityId (its 'exposed' " +
    'assign_surface_coating coating), or pass alpha and eps directly (reported unverified). solarFlux { value, unit } is REQUIRED with its source in your report: llull has no default flux. ' +
    'state BOL | EOL selects alpha (omitted: BOL is used and the result is flagged unverified with EOP_DEFAULT_APPLIED); incidenceAngle (REQUIRED, e.g. 0 deg for a sun-normal plate) scales the flux by cos. Assumptions: no conduction, albedo or planet IR. ' +
    'Returns data { alpha, eps, alphaOverEps, iterations (0 for a constant emissivity), temperatureK, temperatureDegC, solarFluxW_m2, incidenceAngleDeg, radiatingFaces, state, sigma, formula, assumptions, provenance, unverified, unverifiedReasons, reviewRequired }.',
  params: z.object({
    entityId: z.string().optional().describe("Solid whose 'exposed' coating assignment supplies alpha and eps."),
    coating: z.string().optional().describe('Coating material id (overrides entityId).'),
    alpha: z
      .number()
      .optional()
      .describe('Solar absorptivity in [0, 1] given directly (with eps; no coating needed). Reported unverified.'),
    eps: z
      .number()
      .optional()
      .describe('Hemispherical total infrared emissivity in (0, 1] given directly (with alpha). Reported unverified.'),
    solarFlux: z
      .object({ value: z.number().describe('Positive flux.'), unit: z.string().describe("Irradiance unit, e.g. 'W/m^2'.") })
      .optional()
      .describe('REQUIRED. Solar irradiance on the plate normal to the sun; no default.'),
    radiatingFaces: z
      .union([z.literal(1), z.literal(2)])
      .describe('1 = one radiating face (insulated back), 2 = thin plate radiating from both faces.'),
    state: z.enum(['BOL', 'EOL']).optional().describe('Life state of the absorptivity: BOL (default) or EOL.'),
    incidenceAngle: z
      .object({
        value: z.number().describe('Angle between the sun direction and the plate normal.'),
        unit: z.string().describe("Angle unit, e.g. 'deg'."),
      })
      .describe('REQUIRED. Angle between the sun direction and the plate normal: state 0 deg for a sun-normal plate. There is no default.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[] = [], path = 'coating'): CommandResult =>
      refuseEop(doc, COMMAND, code, message, ids, [path]);
    if (params.solarFlux === undefined)
      return fail('EOP_SOLAR_FLUX_MISSING', 'no solar flux was given (there is no default)', [], 'solarFlux');
    const flux = convertValue(params.solarFlux.value, params.solarFlux.unit, 'W/m^2');
    if (isUnitFailure(flux) || !Number.isFinite(flux.value) || flux.value <= 0)
      return fail('EOP_PARAMS_INVALID', 'solarFlux must be a positive irradiance (W/m^2)', [], 'solarFlux');
    const angle = convertValue(params.incidenceAngle.value, params.incidenceAngle.unit, 'rad');
    if (isUnitFailure(angle) || !(Math.cos(angle.value) > 1e-9) || Math.abs(angle.value) >= Math.PI / 2)
      return fail('EOP_PARAMS_INVALID', 'incidenceAngle must be an angle in [0, 90) degrees from the plate normal', [], 'incidenceAngle');
    const state = params.state ?? 'BOL';
    const reasons: string[] = [];
    const provenance: string[] = [];
    let material = params.coating;
    if (material === undefined && (params.alpha === undefined || params.eps === undefined) && params.entityId !== undefined) {
      const exposed = Object.values(electroOpticalOf(doc).coatings).filter(
        (item) => item.entityId === params.entityId && item.location === 'exposed',
      );
      if (exposed.length === 0)
        return fail('EOP_COATING_NOT_ASSIGNED', `'${params.entityId}' has no exposed coating`, [params.entityId], 'entityId');
      if (exposed.length > 1)
        return fail('EOP_COATING_AMBIGUOUS', `'${params.entityId}' has ${exposed.length} exposed coatings`, [params.entityId], 'entityId');
      material = exposed[0]?.coating;
    }
    const needsMaterial = params.alpha === undefined || params.eps === undefined;
    if (needsMaterial && material === undefined)
      return fail('EOP_COATING_NOT_ASSIGNED', 'give coating, entityId with an exposed coating, or alpha and eps');
    if (needsMaterial && (material === undefined || !Object.hasOwn(doc.materials, material)))
      return fail('EOP_COATING_NOT_FOUND', `no coating material '${material}'`, material === undefined ? [] : [material]);
    let alpha = params.alpha;
    if (alpha === undefined) {
      const found = propertyOf(doc, material ?? '', 'absorptivitySolar', { lifeState: state }, {}, ctx);
      if (isMissing(found))
        return fail(
          'EOP_SURFACE_PROPERTY_MISSING',
          `absorptivitySolar (${state}) unavailable: ${found.message}`,
          [material ?? ''],
          'coating',
        );
      alpha = found.value;
      if (params.state === undefined)
        reasons.push('EOP_DEFAULT_APPLIED: state was not given, BOL absorptivity was used (state a life state to clear this)');
      provenance.push(found.provenance);
      reasons.push(...found.unverified.map((reason) => `alpha: ${reason}`));
    } else reasons.push('EOP_VALUE_UNSOURCED: alpha was supplied by the caller without a record');
    if (!(alpha >= 0 && alpha <= 1)) return fail('EOP_PROPERTY_RANGE', `absorptivity ${alpha} is outside [0, 1]`, [], 'alpha');
    let eps = params.eps;
    let temperature: number | null = null;
    let iterations = 0;
    if (eps === undefined) {
      const solved = solveEmissivity(doc, material ?? '', alpha, flux.value, angle.value, params.radiatingFaces, ctx);
      if (isMissing(solved)) return fail(solved.code, solved.message, [material ?? ''], 'coating');
      eps = solved.eps.value;
      temperature = solved.temperature;
      iterations = solved.iterations;
      provenance.push(solved.eps.provenance);
      reasons.push(...solved.eps.unverified.map((reason) => `eps: ${reason}`));
    } else reasons.push('EOP_VALUE_UNSOURCED: eps was supplied by the caller without a record');
    if (!(eps > 0 && eps <= 1)) return fail('EOP_PROPERTY_RANGE', `emissivity ${eps} is outside (0, 1]`, [], 'eps');
    const kelvin = temperature ?? equilibriumTemperature(alpha, flux.value, angle.value, eps, params.radiatingFaces);
    const degC = kelvin - 273.15;
    const data = {
      alpha,
      eps,
      alphaOverEps: alpha / eps,
      temperatureK: kelvin,
      temperatureDegC: degC,
      solarFluxW_m2: flux.value,
      incidenceAngleDeg: (angle.value * 180) / Math.PI,
      radiatingFaces: params.radiatingFaces,
      state,
      iterations,
      sigma: {
        value: STEFAN_BOLTZMANN,
        unit: 'W/(m^2*K^4)',
        source: 'exact SI constants k, h, c: sigma = 2 pi^5 k^4 / (15 h^3 c^2)',
        defaulted: true,
      },
      formula: 'alpha S cos(theta) = n eps sigma T^4',
      assumptions: ['flat plate', 'no conduction', 'no albedo or planet infrared', 'isothermal', 'hemispherical total emissivity'],
      provenance,
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
      reviewRequired: true,
    };
    return report(
      doc,
      `${COMMAND}: T = ${kelvin.toFixed(3)} K (${degC.toFixed(3)} degC) for alpha ${alpha} (${state}), eps ${eps}, alpha/eps ${(alpha / eps).toFixed(4)}, S ${flux.value} W/m^2, ${params.radiatingFaces} radiating face(s)${reasons.length > 0 ? `; unverified: ${reasons.length} reason(s)` : ''}; first estimate, not a thermal analysis.`,
      data,
    );
  },
});
