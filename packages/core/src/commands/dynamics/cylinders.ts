/** Gas pressure on a piston (add_cylinder_pressure). */

import type { CylinderPressure } from '../../model/dynamics';
import { buildTopology, isRefusal } from '../../dynamics/topology';
import { engineLayout } from '../../dynamics/engineGeometry';
import { modelProblem, pressureCurve, tableCoverageProblem } from '../../dynamics/cylinderPressure';
import { DEFAULT_RPM_EXPONENT, WOSCHNI_DEFAULTS } from '../../dynamics/singleZone';
import { toMetres } from '../../model/units';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { idOrNext } from '../entity/explicitId';
import { changed, commandError, failer, rejection } from '../noop';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from './bodies';

/** ISA sea-level pressure, Pa (named default of ambientPressurePa). */
const SEA_LEVEL_PRESSURE = 101_325;

const heatSchema = z.object({
  kind: z
    .enum(['per_cycle_J', 'target_imep_Pa', 'table_vs_rpm'])
    .describe(
      '"per_cycle_J": heat released per cycle (wiebe, single_zone); "target_imep_Pa": calibrate to this net IMEP (wiebe only); "table_vs_rpm": heat per cycle vs rpm (single_zone only).',
    ),
  value: z
    .number()
    .positive()
    .optional()
    .describe('per_cycle_J: joules per cycle per cylinder; target_imep_Pa: net indicated mean effective pressure in Pa (1 bar = 1e5 Pa).'),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe('table_vs_rpm: [[rpm, joules per cycle], ...]; linear between points, flat outside.'),
});

const burnSchema = z.object({
  ca50Deg: z.number().optional().describe('Crank angle of 50 % burned, deg after firing TDC (MBT is about 8-10). Give this OR startDeg.'),
  startDeg: z.number().optional().describe('Start of combustion, deg (negative = before firing TDC); a fixed spark. Give this OR ca50Deg.'),
  durationDeg: z
    .number()
    .positive()
    .describe('Burn duration in crank degrees at 3000 rpm (about 35 for 0-90 % burn at medium speed); scaled by (rpm / 3000)^rpmExponent.'),
  a: z.number().positive().describe('Wiebe efficiency parameter (5 is typical for gasoline).'),
  m: z.number().describe('Wiebe form factor (2 is typical for gasoline).'),
  rpmExponent: z.number().optional().describe(`Exponent of the burn-duration speed scaling. Default ${DEFAULT_RPM_EXPONENT}.`),
});

const woschniSchema = z.object({
  c1: z.number().positive().describe(`Woschni pre-factor (${WOSCHNI_DEFAULTS.c1}).`),
  c2Closed: z.number().positive().describe(`Gas-velocity coefficient with the valves closed (${WOSCHNI_DEFAULTS.c2Closed}).`),
  c2Exchange: z
    .number()
    .positive()
    .describe(
      `Gas-velocity coefficient during gas exchange (${WOSCHNI_DEFAULTS.c2Exchange}); kept in the record, the exchange strokes are prescribed pressures.`,
    ),
  c3: z.number().min(0).describe(`Combustion-term coefficient (${WOSCHNI_DEFAULTS.c3}).`),
  tempExponent: z.number().describe(`Gas temperature exponent (${WOSCHNI_DEFAULTS.tempExponent}; -0.55 in some sources).`),
  wallTempK: z.number().positive().describe(`Mean wall temperature, K (${WOSCHNI_DEFAULTS.wallTempK}).`),
});

const modelSchema = z.object({
  kind: z.enum(['table', 'wiebe', 'single_zone']).describe('Pressure model: "table", "wiebe" or "single_zone".'),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .describe(
      'table: [[cycle angle deg, GAUGE pressure Pa], ...]; angle 0 = firing TDC, must cover 0..720 (four_stroke) or 0..360; periodic.',
    ),
  startDeg: z.number().optional().describe('wiebe: start of combustion, deg (negative = before firing TDC, e.g. -15).'),
  durationDeg: z.number().positive().optional().describe('wiebe: burn duration, crank deg (e.g. 50).'),
  a: z.number().positive().optional().describe('wiebe: Wiebe a (5 is typical for gasoline).'),
  m: z.number().optional().describe('wiebe: Wiebe m (2 is typical for gasoline).'),
  compressionIndex: z
    .number()
    .optional()
    .describe('wiebe: polytropic index n_c of compression and burn, > 1 (about 1.3). Required, no default.'),
  expansionIndex: z.number().optional().describe('wiebe: polytropic index n_e of expansion, > 1 (about 1.3). Required, no default.'),
  intakePressurePa: z
    .number()
    .positive()
    .optional()
    .describe('wiebe, single_zone: absolute pressure at intake closing (bottom dead centre), Pa.'),
  intakeTempK: z.number().positive().optional().describe('single_zone: charge temperature at intake closing, K (e.g. 330).'),
  heat: heatSchema
    .optional()
    .describe(
      'wiebe: per_cycle_J or target_imep_Pa. single_zone: per_cycle_J or table_vs_rpm (calibration to a brake target needs engine losses and is not offered yet).',
    ),
  burn: burnSchema.optional().describe('single_zone: Wiebe burn phasing.'),
  woschni: woschniSchema
    .optional()
    .describe('single_zone: Woschni heat-transfer constants; missing ones take the stated defaults and are stored.'),
  source: z.string().optional().describe('Where the pressure data or constants come from; without one the result is flagged unverified.'),
});

type ModelInput = z.output<typeof modelSchema>;

/** The stored model of a call, or the first missing / inconsistent field. */
function storedModel(input: ModelInput): CylinderPressure['model'] | { error: string } {
  const source = input.source !== undefined ? { source: input.source } : {};
  if (input.kind === 'table') {
    if (input.points === undefined || input.points.length < 2)
      return { error: 'table needs points [[cycleDeg, gaugePa], ...] (at least 2)' };
    return { kind: 'table', points: input.points, ...source };
  }
  const heat = input.heat;
  if (input.intakePressurePa === undefined) return { error: `${input.kind} needs intakePressurePa` };
  if (input.kind === 'wiebe') {
    const { startDeg, durationDeg, a, m, compressionIndex, expansionIndex } = input;
    if (startDeg === undefined || durationDeg === undefined || a === undefined || m === undefined)
      return { error: 'wiebe needs startDeg, durationDeg, a and m' };
    if (compressionIndex === undefined || expansionIndex === undefined)
      return { error: 'wiebe needs compressionIndex and expansionIndex (no defaults: no fetched source gives them)' };
    if (heat === undefined || heat.value === undefined || (heat.kind !== 'per_cycle_J' && heat.kind !== 'target_imep_Pa'))
      return { error: 'wiebe needs heat { kind: "per_cycle_J" | "target_imep_Pa", value }' };
    return {
      kind: 'wiebe',
      startDeg,
      durationDeg,
      a,
      m,
      compressionIndex,
      expansionIndex,
      intakePressurePa: input.intakePressurePa,
      heat: { kind: heat.kind, value: heat.value },
      ...source,
    };
  }
  const burn = input.burn;
  if (burn === undefined) return { error: 'single_zone needs burn { ca50Deg | startDeg, durationDeg, a, m }' };
  if ((burn.ca50Deg === undefined) === (burn.startDeg === undefined))
    return { error: 'single_zone burn needs exactly one of ca50Deg and startDeg' };
  if (input.intakeTempK === undefined) return { error: 'single_zone needs intakeTempK' };
  let storedHeat: Extract<CylinderPressure['model'], { kind: 'single_zone' }>['heat'];
  if (heat?.kind === 'per_cycle_J' && heat.value !== undefined) storedHeat = { kind: 'per_cycle_J', value: heat.value };
  else if (heat?.kind === 'table_vs_rpm' && heat.points !== undefined && heat.points.length > 0)
    storedHeat = { kind: 'table_vs_rpm', points: heat.points };
  else return { error: 'single_zone needs heat { kind: "per_cycle_J", value } or { kind: "table_vs_rpm", points }' };
  const rpmExponent = burn.rpmExponent ?? DEFAULT_RPM_EXPONENT;
  const common = { durationDeg: burn.durationDeg, a: burn.a, m: burn.m, rpmExponent };
  return {
    kind: 'single_zone',
    burn: burn.ca50Deg !== undefined ? { ca50Deg: burn.ca50Deg, ...common } : { startDeg: burn.startDeg ?? 0, ...common },
    woschni: input.woschni ?? { ...WOSCHNI_DEFAULTS },
    intakePressurePa: input.intakePressurePa,
    intakeTempK: input.intakeTempK,
    heat: storedHeat,
    ...source,
  };
}

/**
 * @affects adds 1 cylinder pressure to doc.dynamics.cylinders (affected: [cylinderId], step-scoped id cyl-<step>.<k>)
 * @invariant piston prismatic and crank revolute (both tree joints), at most one pressure per piston; bore > 0; compression ratio > 1;
 *            firingOffsetDeg a multiple of 360; the pressure table covers the cycle; calibrate_brake is NOT offered (it needs the
 *            engine-loss model of a later slice) and is absent from the schema rather than stubbed
 * @failure unknown / wrong-kind joints, a loop-closing piston or crank, a second pressure on a piston, missing model fields,
 *          FPR_PRESSURE_TABLE_GAP, FPR_IMEP_UNREACHABLE, taken id -> no-op
 */
export const addCylinderPressure = defineCommand({
  name: 'add_cylinder_pressure',
  description:
    'Gas pressure on a piston, for simulate_motion: force = (p - ambient) x bore area pushes the piston toward the crank, applied as the ' +
    'generalised force of the prismatic joint `piston` (the cylinder body gets the reaction). The crank joint gives the crank angle. ' +
    'Needs the slider-crank joints already declared (crank revolute to ground, rod revolute on the crank, wrist pin revolute or ' +
    'spherical rod-to-piston, piston prismatic): crank radius, rod length, cylinder axis and the crank angle of the top dead centre ' +
    '(TDC) are read from their anchors at t = 0 (set tdcCrankAngleDeg to override). Units: bore mm; pressures Pa (1 bar = 1e5 Pa); ' +
    'angles deg; heat J per cycle per cylinder. cycle "four_stroke" (default, 720 deg) or "two_stroke" (360). Cycle angle 0 = firing TDC, ' +
    'intake 360-540, compression 540-720, power 0-180, exhaust 180-360. firingOffsetDeg: which TDC crossing of this piston fires, 0 or ' +
    '360 (multi-cylinder firing order comes from the crank-pin phasing of the geometry plus this 0/360 choice). The crank must turn in ' +
    'the positive sense of its joint axis (flip the axis otherwise). Models: "table" = gauge pressure vs cycle angle (must cover the ' +
    'whole cycle, else FPR_PRESSURE_TABLE_GAP; give `source` or results are unverified). "wiebe" = single zone without heat loss: ' +
    'polytropic compression (n_c) and expansion (n_e) with a Wiebe heat release (startDeg, durationDeg, a, m; gasoline a 5, m 2), heat ' +
    'per cycle OR calibrated exactly to a net `target_imep_Pa` (FPR_IMEP_UNREACHABLE when it is below the unfired loop). n_c, n_e and ' +
    'intakePressurePa are required, no defaults. "single_zone" = first law with Wiebe burn (ca50Deg 8-10 for MBT, or fixed startDeg; ' +
    'durationDeg about 35 at 3000 rpm), Woschni wall heat loss (constants default to 3.26 / 2.28 / 6.18 / 0.00324, exponent -0.53, wall ' +
    '450 K and are stored), charge at intake closing (intakePressurePa, intakeTempK), heat per cycle or per rpm (calibration to a ' +
    'brake torque needs engine losses and is not available yet). Returns the cylinder id (cyl-<step>.<k>) in affected[0]; the summary ' +
    'gives geometry, peak pressure and IMEP. Next: simulate_motion (reactions peaks, data.engine), or engine_quick_check for a ' +
    'sanity check without simulation.',
  params: z.object({
    piston: z.string().describe('Id of the prismatic joint of the piston (add_body_joint kind prismatic).'),
    crank: z.string().describe('Id of the revolute joint of the crankshaft (its angle is the engine angle).'),
    boreMm: z.number().positive().describe('Cylinder bore diameter, mm.'),
    compressionRatio: z.number().gt(1).describe('Geometric compression ratio (V_max / V_min), > 1.'),
    cycle: z.enum(['four_stroke', 'two_stroke']).optional().describe('"four_stroke" (default) or "two_stroke".'),
    firingOffsetDeg: z.number().optional().describe('Which TDC crossing fires: 0 (default) or 360 for a four-stroke.'),
    tdcCrankAngleDeg: z
      .number()
      .optional()
      .describe('Crank joint angle (deg from its t = 0 pose) at which this piston is at TDC; default computed from the geometry.'),
    ambientPressurePa: z
      .number()
      .positive()
      .optional()
      .describe(`Ambient pressure acting under the piston, Pa. Default ${SEA_LEVEL_PRESSURE} (ISA sea level).`),
    model: modelSchema.describe('Pressure model; see the command description.'),
    id: z.string().optional().describe('Optional explicit cylinder id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_cylinder_pressure');
    const dynamics = dynamicsOf(doc);
    const piston = dynamics.joints[params.piston];
    const crank = dynamics.joints[params.crank];
    if (piston === undefined) return fail(`piston joint '${params.piston}' not found (add_body_joint kind prismatic first)`);
    if (piston.kind !== 'prismatic') return fail(`piston '${piston.id}' is ${piston.kind}; it must be a prismatic joint`);
    if (crank === undefined) return fail(`crank joint '${params.crank}' not found`);
    if (crank.kind !== 'revolute') return fail(`crank '${crank.id}' is ${crank.kind}; it must be a revolute joint`);
    const clash = Object.values(dynamics.cylinders ?? {}).find((existing) => existing.piston === piston.id);
    if (clash !== undefined) return fail(`piston '${piston.id}' already has cylinder pressure '${clash.id}'`);
    const model = storedModel(params.model);
    if ('error' in model) return fail(model.error);
    const cycle = params.cycle ?? 'four_stroke';
    if (model.kind === 'table') {
      const gap = tableCoverageProblem(model.points, cycle);
      if (gap !== null)
        return rejection(
          doc,
          `add_cylinder_pressure: FPR_PRESSURE_TABLE_GAP — ${gap}; no-op.`,
          commandError('FPR_PRESSURE_TABLE_GAP', gap, [piston.id]),
        );
    }
    const cylinderId = idOrNext(params.id, 'cyl');
    if (dynamicsIdTaken(dynamics, cylinderId)) return fail(`id '${cylinderId}' is already used`);
    const cylinder: CylinderPressure = {
      id: cylinderId,
      piston: piston.id,
      crank: crank.id,
      boreMm: params.boreMm,
      compressionRatio: params.compressionRatio,
      cycle,
      firingOffsetDeg: params.firingOffsetDeg ?? 0,
      tdcCrankAngleRad: params.tdcCrankAngleDeg === undefined ? null : (params.tdcCrankAngleDeg * Math.PI) / 180,
      ambientPressurePa: params.ambientPressurePa ?? SEA_LEVEL_PRESSURE,
      model,
    };
    const problem = modelProblem(cylinder);
    if (problem !== null) return fail(problem);
    const topology = buildTopology(dynamics);
    let geometryText = 'geometry not checked yet (declare the rod and wrist joints; it is read at simulate_motion)';
    if (!isRefusal(topology)) {
      if (!topology.tree.some((entry) => entry.joint.id === piston.id) || !topology.tree.some((entry) => entry.joint.id === crank.id))
        return fail(
          `the piston and crank joints must be tree joints, but '${topology.loops.find((l) => l.id === piston.id || l.id === crank.id)?.id ?? piston.id}' closes a loop`,
        );
      const layout = engineLayout(dynamics, topology, cylinder, toMetres(doc, 1));
      if (!('error' in layout)) {
        const curve = pressureCurve(cylinder, layout, 1000);
        if ('error' in curve)
          return rejection(
            doc,
            `add_cylinder_pressure: ${curve.code} — ${curve.error}; no-op.`,
            commandError(curve.code, curve.error, [piston.id]),
          );
        geometryText =
          `crank radius ${(layout.slider.r * 1000).toPrecision(5)} mm, rod ${(layout.slider.l * 1000).toPrecision(5)} mm, stroke ${(layout.strokeM * 1000).toPrecision(5)} mm` +
          `${layout.offset ? ' (offset cylinder)' : ''}, displacement ${(layout.displacementM3 * 1e6).toPrecision(5)} cm³, ` +
          `TDC at crank ${((layout.topCrankAngleRad * 180) / Math.PI).toFixed(2)} deg, peak ${(curve.peakPa / 1e5).toPrecision(4)} bar at ${curve.peakAngleDeg.toFixed(1)} deg, ` +
          `net IMEP ${(curve.imepPa / 1e5).toPrecision(4)} bar${curve.heatJ !== null ? `, heat ${curve.heatJ.toPrecision(5)} J/cycle` : ''}`;
      } else geometryText = `geometry not usable yet (${layout.error}); it is read at simulate_motion`;
    }
    const unverified = model.source === undefined ? ' Unverified: no source given for the pressure data.' : '';
    return changed(
      withDynamics(doc, { ...dynamics, cylinders: { ...(dynamics.cylinders ?? {}), [cylinderId]: cylinder } }),
      `add_cylinder_pressure: '${cylinderId}' — ${model.kind} ${cycle} on piston '${piston.id}', crank '${crank.id}', bore ${params.boreMm} mm, CR ${params.compressionRatio}; ${geometryText}.${unverified}`,
      [cylinderId],
    );
  },
});
