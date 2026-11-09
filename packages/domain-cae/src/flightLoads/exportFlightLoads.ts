/** export_flight_loads: a flight-run instant (or the envelope of instants) as load cases of a static analysis (14 FLL). */

import type { AnalysisCase, FeaLoad, FlightLoadSource, LoadCategory } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { nextId } from '@lib/id';
import { unitSystemFactors } from '../decks/units';
import { caseOf, withCase } from '../shared/access';
import { loadCaseNameProblem } from '../shared/names';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { refuseFll } from './codes';
import { flightDesignHash } from './designHash';
import { chooseInstants, flightInstants, type ChosenInstant, type FlightInstant } from './flightInstants';
import { analysedCentre } from './rigidBalance';

const NEWTON_PER_LBF = 4.4482216152605;
/** Sampling of the run the instants are read from, Hz (accelerations are central differences of the recorded velocity). */
const DEFAULT_SAMPLE_RATE = 1000;
/** Effective sampling below which the finite-difference acceleration can miss the 1e-4 relief gate (about 1e-3 at 200 Hz, 1e-6 at 1 kHz). */
const LOW_SAMPLE_RATE_HZ = 900;
/** Standard gravity of a flight document without a dynamics model, m/s^2 (world Z up). */
const DEFAULT_GRAVITY: Vec3 = [0, 0, -9.80665];

const mountSchema = z.object({
  name: z.string().min(1).describe('Name of the mount, e.g. "motor arm 1"; names its loads.'),
  target: feaTargetSchema.describe(
    'Where the interface load acts: faces (spread), edges or points of a part of the analysis. The relief balance takes the force to act at the MEAN of these points (not the meshed face centroid): for a face mount give points around its centroid.',
  ),
  force: vec3(
    'Fixed interface force [x, y, z] in model axes, in the case unit system (N-mm-t-s: N), the same at every exported instant.',
  ).optional(),
  rotorId: z
    .string()
    .optional()
    .describe('Rotor (add_rotor) whose thrust at the instant is the interface force: needs scenario and direction.'),
  direction: vec3(
    'With rotorId: the thrust direction [x, y, z] in model axes (any length; normalised). The force is thrust(t) x this direction.',
  ).optional(),
  moment: vec3(
    'Interface moment [mx, my, mz] in the case unit system (N-mm-t-s: N.mm); the target needs a face, an edge or three points.',
  ).optional(),
});

const stateSchema = z.object({
  linearAccel: vec3('Absolute acceleration of the reference point [x, y, z], m/s^2, in model axes.'),
  angularVelocity: vec3('Angular velocity [x, y, z], rad/s, in model axes.'),
  angularAccel: vec3('Angular acceleration [x, y, z], rad/s^2, in model axes.'),
  gravity: vec3('Gravity field [x, y, z], m/s^2 in model axes, added as a gravity load. Default: none.').optional(),
});

type Mount = z.output<typeof mountSchema>;

const sanitize = (text: string): string => text.replace(/[^A-Za-z0-9_]/g, '_');
const countOf = (points: readonly unknown[] | undefined): number => (points === undefined ? 0 : points.length);

/** The load of one mount at an instant, or a refusal text. */
function mountLoads(
  mount: Mount,
  instant: FlightInstant | null,
  loadCase: string,
  category: LoadCategory,
  forceUnit: number,
  source: FlightLoadSource,
): FeaLoad[] | string {
  const base = { loadCase, category, flightSource: source, target: toTarget(mount.target) } as const;
  const out: FeaLoad[] = [];
  let force: Vec3 | undefined = mount.force;
  if (mount.rotorId !== undefined) {
    const direction = mount.direction;
    if (direction === undefined || !(Math.hypot(...direction) > 0)) return `mount '${mount.name}': rotorId needs a non-zero direction`;
    const thrust = instant?.thrustN[mount.rotorId];
    if (thrust === undefined) return `mount '${mount.name}': the run has no thrust of rotor '${mount.rotorId}'`;
    const length = Math.hypot(...direction);
    force = direction.map((component) => (thrust * component * forceUnit) / length) as unknown as Vec3;
  } else if (mount.direction !== undefined) return `mount '${mount.name}': direction needs a rotorId`;
  if (force === undefined && mount.moment === undefined) return `mount '${mount.name}': give a force, a rotorId + direction, or a moment`;
  if (force !== undefined && force.some((component) => component !== 0))
    out.push({ ...base, id: nextId('fl'), name: `${mount.name} force`, kind: 'force', vector: force, distribution: 'total' });
  if (mount.moment !== undefined) {
    const target = mount.target;
    if (countOf(target.facesNear) === 0 && countOf(target.edgesNear) === 0 && countOf(target.pointsNear) < 3)
      return `mount '${mount.name}': a moment needs a face, an edge or at least three points in its target`;
    if (mount.moment.some((component) => component !== 0))
      out.push({ ...base, id: nextId('fl'), name: `${mount.name} moment`, kind: 'moment', vector: mount.moment });
  }
  return out;
}

/** Existing loads of the analysis without those exported earlier into `cases` (re-exporting replaces them); a case with other loads is a refusal text. */
function withoutPrevious(analysis: AnalysisCase, cases: readonly string[]): { loads: Record<string, FeaLoad>; order: string[] } | string {
  const loads: Record<string, FeaLoad> = {};
  const order: string[] = [];
  for (const id of analysis.loadOrder) {
    const load = analysis.loads[id];
    if (load === undefined) continue;
    if (cases.includes(load.loadCase)) {
      if (load.flightSource === undefined) return `load case '${load.loadCase}' already has hand-made loads: choose another loadCase name`;
      continue;
    }
    loads[id] = load;
    order.push(id);
  }
  return { loads, order };
}

const caseName = (base: string, chosen: ChosenInstant, many: boolean, fromRun: boolean): string =>
  !fromRun
    ? base
    : chosen.label === 't'
      ? `${base}_t${Math.round(chosen.instant.timeS * 1000)}ms`
      : many || chosen.label !== 'peak'
        ? `${base}_${chosen.label}`
        : `${base}_peak`;

function readRun(
  doc: CadDocument,
  params: { scenario: string; sampleRate?: number | undefined },
  ctx: ExecutionContext | undefined,
): FlightInstant[] | string {
  const run = ctx?.registry('run_flight');
  if (run === undefined) return 'run_flight is not registered (the dynamics plugin is not installed)';
  const result = run.run(doc, { scenario: params.scenario, sampleRate: params.sampleRate ?? DEFAULT_SAMPLE_RATE, detail: 'series' }, ctx);
  const series = (result.data as { series?: unknown } | undefined)?.series;
  if (result.rejected === true || series === undefined) return result.summary;
  return flightInstants(series, doc.dynamics?.gravity ?? DEFAULT_GRAVITY);
}

/**
 * @affects doc.analysis.cases[analysisId].loads (adds, per chosen instant, one inertial load, a gravity load and the mount force / moment loads, ids `fl-<step>.<k>`;
 *   loads exported earlier into the same load case names are replaced)
 * @invariant the inertial load holds the absolute acceleration of the reference point O and the angular state in model axes; the deck applies -rho (a + alpha x r + omega x (omega x r))
 *   and the gravity load adds the weight, so mounts that carry the vehicle thrust balance the part (check_analysis FLL_RELIEF_RESIDUAL otherwise); every load records the scenario, instant and design hash
 *   (FLL_RUN_STALE when the design changed); acceleration = central difference of the recorded velocity, so it is as accurate as the sample rate
 * @failure unknown analysis, non-static analysis, scenario / state both or neither, run refused (code in detail), instant outside the run, invalid mount, load case with hand-made loads -> refusal, unchanged doc
 */
export const exportFlightLoads = defineCommand({
  name: 'export_flight_loads',
  description:
    'Turn a flight into load cases of a static FEA analysis (14 FLL, inertial relief): the rigid-body state (absolute acceleration a of the ' +
    'reference point O, angular velocity and acceleration, gravity) at an instant of a flight scenario, plus the interface forces / moments at ' +
    'named mounts. Source: scenario (+ at) flies it with run_flight and reads the series (acceleration and angular acceleration are central ' +
    'differences of the 1 kHz default samples, rotated into the start-attitude model axes: the model axes must be the vehicle axes at t = 0), or an ' +
    'explicit state (m/s^2, rad/s, rad/s^2) without a flight. at = a time in s (nearest sample), "peak_load" (largest specific force |a - g|, ' +
    'default) or "envelope" (peaks of specific force, angular velocity and angular acceleration: up to three load cases). Each load case gets an ' +
    'inertial load, a gravity load and one force load per mount: a mount is a target with a fixed force, or a rotorId + direction (force = rotor ' +
    "thrust at the instant x direction). The deck applies the d'Alembert body force -rho (a + alpha x r + omega x (omega x r)) (uniform part as CalculiX " +
    'GRAV, rotation about O as CENTRIF, angular acceleration as one GRAV per element). The loads are balanced when the mounts carry m(a - g) ' +
    'and the moments; add set_free_body_support so the model is statically determinate, and check_analysis reports FLL_RELIEF_RESIDUAL when ' +
    'it is not balanced (the supports would then take the difference) and FLL_RUN_STALE when the design changed after the run. Re-exporting ' +
    'into the same load case names replaces the earlier flight loads. Needs a static analysis.',
  params: z.object({
    analysisId: analysisIdSchema,
    scenario: z.string().optional().describe('Id of the flight scenario to fly (define_flight_scenario). Give this or state.'),
    at: z
      .union([z.number().min(0), z.enum(['peak_load', 'envelope'])])
      .optional()
      .describe('With scenario: a time in s from the start, "peak_load" (default) or "envelope".'),
    state: stateSchema.optional().describe('Explicit rigid-body state instead of a scenario (one load case).'),
    referencePoint: vec3(
      'Point O [x, y, z] in document units the acceleration refers to (the vehicle centre of mass). Default: the centre of mass of the analysed parts.',
    ).optional(),
    mounts: z.array(mountSchema).optional().describe('Interface loads at named mounts. Default none (the loads are then unbalanced).'),
    loadCase: z
      .string()
      .optional()
      .describe(
        'Base load case name (1-40 letters, digits, underscores; suffixes _peak, _t<ms>ms, _peak_f / _w / _a are appended). Default FLT_<scenario> or FLT_state.',
      ),
    category: z.enum(['limit', 'ultimate']).optional().describe('limit (default) or ultimate.'),
    sampleRate: z
      .number()
      .positive()
      .max(10000)
      .optional()
      .describe(
        'Samples per second of the run the instants are read from. Default 1000 (a run longer than 6 s is coarsened by run_flight to 6001 samples; data.effectiveSampleRateHz reports the real rate and the summary warns below 900 Hz).',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId } = params;
    const fail = (code: string, message: string, ids: readonly string[] = [analysisId], paths: readonly string[] = []): CommandResult =>
      refuseFll(doc, 'export_flight_loads', code, message, ids, paths);
    const analysis = caseOf(doc, analysisId);
    if (analysis === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    if (analysis.type !== 'static') return fail('FLL_ANALYSIS_TYPE', `analysis '${analysisId}' is ${analysis.type}, not static`);
    if ((params.scenario === undefined) === (params.state === undefined))
      return fail('FLL_SOURCE_AMBIGUOUS', 'give either scenario or state', [analysisId], ['scenario', 'state']);
    const category = params.category ?? 'limit';
    const factors = unitSystemFactors(analysis.unitSystem);
    const accelUnit = 1 / factors.metresPerLength;
    const forceUnit = analysis.unitSystem === 'lbf-in-slinch-s' ? 1 / NEWTON_PER_LBF : 1;
    const designHash = flightDesignHash(doc, analysis);
    let chosen: ChosenInstant[];
    let effectiveHz: number | null = null;
    if (params.state !== undefined) {
      const s = params.state;
      chosen = [
        {
          instant: {
            index: 0,
            timeS: 0,
            accelMps2: s.linearAccel,
            gravityMps2: s.gravity ?? [0, 0, 0],
            angularVelocity: s.angularVelocity,
            angularAccel: s.angularAccel,
            thrustN: {},
          },
          label: 'state',
        },
      ];
    } else {
      const instants = readRun(doc, { scenario: params.scenario ?? '', sampleRate: params.sampleRate }, ctx);
      if (typeof instants === 'string') return fail('FLL_RUN_FAILED', instants, [analysisId, params.scenario ?? '']);
      const first = Math.min(...instants.map((instant) => instant.timeS));
      const at = params.at ?? 'peak_load';
      const last = Math.max(...instants.map((instant) => instant.timeS));
      if (typeof at === 'number' && at > last + 1e-9)
        return fail(
          'FLL_INSTANT_UNKNOWN',
          `time ${at} s is after the end of the run (${last} s)`,
          [analysisId, params.scenario ?? ''],
          ['at'],
        );
      effectiveHz = last > first ? (instants.length - 1) / (last - first) : null;
      chosen = chooseInstants(instants, at);
    }
    const fromRun = params.scenario !== undefined;
    const base = params.loadCase ?? (fromRun ? `FLT_${sanitize(params.scenario ?? '')}` : 'FLT_state');
    const names = chosen.map((pick) => caseName(base, pick, chosen.length > 1, fromRun));
    for (const name of names) {
      const problem = loadCaseNameProblem(name);
      if (problem !== null) return fail('FEA_LOAD_INVALID', problem, [analysisId], ['loadCase']);
    }
    const previous = withoutPrevious(analysis, names);
    if (typeof previous === 'string') return fail('FEA_LOAD_INVALID', previous, [analysisId], ['loadCase']);
    const reference = ((): Vec3 | null => {
      if (params.referencePoint !== undefined) return params.referencePoint;
      const centre = analysedCentre(doc, analysis, ctx);
      return typeof centre === 'string' ? null : centre;
    })();
    if (reference === null)
      return fail(
        'FLL_STATE_INVALID',
        'referencePoint is needed: the centre of mass of the analysed parts cannot be computed',
        [analysisId],
        ['referencePoint'],
      );
    const added: FeaLoad[] = [];
    const summaries: string[] = [];
    const data: Record<string, unknown>[] = [];
    for (const [index, pick] of chosen.entries()) {
      const loadCase = names[index] ?? base;
      const instant = pick.instant;
      const source: FlightLoadSource = {
        scenario: params.scenario ?? null,
        timeS: fromRun ? instant.timeS : null,
        designHash: fromRun ? designHash : null,
      };
      const common = { loadCase, category, flightSource: source } as const;
      const loads: FeaLoad[] = [
        {
          ...common,
          id: nextId('fl'),
          name: `inertial ${loadCase}`,
          kind: 'inertial',
          vector: instant.accelMps2.map((c) => c * accelUnit) as unknown as Vec3,
          angularVelocity: instant.angularVelocity,
          angularAccel: instant.angularAccel,
          referencePoint: reference,
        },
      ];
      if (instant.gravityMps2.some((component) => component !== 0))
        loads.push({
          ...common,
          id: nextId('fl'),
          name: `gravity ${loadCase}`,
          kind: 'gravity',
          vector: instant.gravityMps2.map((c) => c * accelUnit) as unknown as Vec3,
        });
      for (const mount of params.mounts ?? []) {
        const problem = targetProblem(doc, analysis, toTarget(mount.target));
        if (problem !== null)
          return fail(problem.code, `mount '${mount.name}': ${problem.message}`, [analysisId, mount.target.entityId], ['mounts']);
        const made = mountLoads(mount, instant, loadCase, category, forceUnit, source);
        if (typeof made === 'string') return fail('FLL_MOUNT_INVALID', made, [analysisId], ['mounts']);
        loads.push(...made);
      }
      added.push(...loads);
      const norm = (v: Vec3): number => Math.hypot(...v);
      summaries.push(
        `'${loadCase}'${fromRun ? ` at t = ${Number(instant.timeS.toPrecision(5))} s` : ''}: |a| ${Number(norm(instant.accelMps2).toPrecision(4))} m/s^2, |omega| ${Number(norm(instant.angularVelocity).toPrecision(4))} rad/s, |alpha| ${Number(norm(instant.angularAccel).toPrecision(4))} rad/s^2, ${loads.length} load(s)`,
      );
      data.push({
        loadCase,
        timeS: fromRun ? instant.timeS : null,
        pick: pick.label,
        accelMps2: instant.accelMps2,
        gravityMps2: instant.gravityMps2,
        angularVelocity: instant.angularVelocity,
        angularAccel: instant.angularAccel,
        thrustN: instant.thrustN,
        loadIds: loads.map((load) => load.id),
      });
    }
    const next: AnalysisCase = {
      ...analysis,
      loads: { ...previous.loads, ...Object.fromEntries(added.map((load) => [load.id, load])) },
      loadOrder: [...previous.order, ...added.map((load) => load.id)],
    };
    const result = changed(
      withCase(doc, next),
      `export_flight_loads: ${chosen.length} load case(s) in '${analysisId}' from ${fromRun ? `scenario '${params.scenario}'` : 'an explicit state'} about O = [${reference.map((c) => Number(c.toPrecision(5))).join(', ')}]: ${summaries.join('; ')}. ` +
        (effectiveHz !== null && effectiveHz < LOW_SAMPLE_RATE_HZ
          ? ` WARNING: the run was sampled at ${Number(effectiveHz.toPrecision(4))} Hz (a long run is coarsened to 6001 samples): the finite-difference acceleration may miss the 1e-4 relief gate, shorten the scenario or the instant window.`
          : '') +
        ' Add set_free_body_support and check_analysis (FLL_RELIEF_RESIDUAL) before solving.',
      added.map((load) => load.id),
    );
    return {
      ...result,
      data: {
        analysisId,
        referencePoint: reference,
        designHash: fromRun ? designHash : null,
        effectiveSampleRateHz: effectiveHz,
        instants: data,
      },
    };
  },
});
