/**
 * Realism section of the engine report (FR-FPR-70 / 71 / 73 / 76, TECHNICAL_SPEC 5.8): brake torque, BMEP, FMEP and mechanical efficiency from
 * the simulated gas torque and the loss law, the reciprocating mass and inertia-force amplitudes, the accuracy statement of every scalar, and
 * the plausibility findings. Pure functions of one run; nothing here changes the simulation.
 */

import type { DynamicsModel, EngineLosses } from '@core/model/dynamics';
import type { CylinderRuntime } from '../cylinderLoads';
import type { EngineData } from '../engineReport';
import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import { inertiaAboutAxis } from '../simulationModel';
import type { BodyMassProperties } from '@core/geometry/bodyMassProperties';
import { scale3 } from '@lib/vec3';
import {
  CA50_BAND_DEG,
  degreesAfterTdc,
  MECHANICAL_EFFICIENCY_BAND,
  PEAK_ANGLE_BAND_DEG,
  ROTAX_MAX_PROPELLER_TORQUE_NM,
  ROTAX_PROPELLER_INERTIA_BAND,
  isRotaxReduction,
  outsideBand,
  type PlausibilityFinding,
} from './plausibility';
import { accuracy, RIGID_BODY_WARNING, type Accuracy, type AccuracyBand } from '../accuracy';
import { combustionOrigin } from './combustionOrigin';
import { efficiencyBand, fmepAt, fmepBand, frictionOrigin, lossBands, ownsCylinder } from './engineLosses';
import { elementAt } from '@lib/elementAt';

/** Share of the connecting-rod mass counted as reciprocating (the usual lumped-mass rule, named). */
const ROD_RECIPROCATING_SHARE = 1 / 3;
/** The tolerance the brake calibration converges to (TECHNICAL_SPEC 5.9): the band of a calibrated value. */
const CALIBRATION_BAND = 1e-3;

interface LossReport {
  readonly id: string;
  readonly model: 'chen_flynn' | 'fmep_table';
  readonly source: string;
  readonly crankJoint: string;
  readonly rpm: number;
  readonly displacementCm3: number;
  readonly peakPressureBar: number;
  readonly fmepBar: number;
  readonly frictionTorqueNm: number;
  readonly indicatedTorqueNm: number;
  readonly brakeTorqueNm: number;
  readonly brakePowerKW: number;
  readonly imepBar: number;
  readonly bmepBar: number;
  readonly mechanicalEfficiency: number;
  /** The speed governor's mean torque over the last cycle, when it is the only other load; |it| should equal the brake torque. */
  readonly governorCrossCheck: { readonly governorMeanTorqueNm: number; readonly relativeDifference: number } | null;
  readonly outsideValidatedRange: boolean;
  /** The friction fit gave a negative FMEP at this point; it was clamped to 0. */
  readonly fmepClamped: boolean;
}

interface ReciprocatingReport {
  readonly cylinder: string;
  readonly pistonBody: string;
  readonly rodBody: string;
  readonly reciprocatingMassKg: number;
  /** m r w² and m r lambda w² at the run's mean speed, N. */
  readonly primaryForceN: number;
  readonly secondaryForceN: number;
  readonly gasPeakForceN: number;
  /** Primary inertia amplitude / peak gas force: how large inertia is against the gas load. */
  readonly inertiaToGasRatio: number;
  readonly massDefaulted: boolean;
}

export interface RealismData {
  readonly losses: LossReport | null;
  readonly reciprocating: ReciprocatingReport[];
  /** Keyed like the numbers of the engine report (meanTorqueNm, brakeTorqueNm, ...). */
  readonly accuracy: Record<string, Accuracy>;
  readonly plausibility: PlausibilityFinding[];
  /** One line per plausibility finding and per unverified input. */
  readonly warnings: string[];
}

export interface RealismInput {
  readonly dynamics: DynamicsModel;
  readonly runtimes: readonly CylinderRuntime[];
  readonly trace: SimulationTrace;
  readonly mass: Readonly<Record<string, BodyMassProperties>>;
  readonly report: EngineData;
  /** Absorbed torque of each propeller at the end of the run, N·m. */
  readonly propellerTorqueNm: Readonly<Record<string, number>>;
  readonly metresPerUnit: number;
}

/** Mean of a joint series over [fromS, toS] by the trapezoid rule on the recorded samples. */
function meanOver(times: readonly number[], values: readonly number[], fromS: number, toS: number): number | null {
  let [area, span] = [0, 0];
  for (let i = 1; i < times.length; i++) {
    const [t0, t1] = [elementAt(times, i - 1), elementAt(times, i)];
    if (t0 < fromS - 1e-12 || t1 > toS + 1e-12) continue;
    area += 0.5 * (elementAt(values, i - 1) + elementAt(values, i)) * (t1 - t0);
    span += t1 - t0;
  }
  return span > 0 ? area / span : null;
}

/** True when nothing but the speed governor loads the crank, so the governor torque equals minus the brake torque. */
function governorIsOnlyLoad(dynamics: DynamicsModel, crank: string): boolean {
  const governors = Object.values(dynamics.motors).filter((motor) => motor.kind === 'speed' && motor.joint === crank);
  return (
    governors.length === 1 &&
    Object.values(dynamics.motors).length === 1 &&
    Object.keys(dynamics.propellers).length === 0 &&
    Object.keys(dynamics.gears).length === 0 &&
    Object.values(dynamics.joints).every((joint) => joint.damping === 0 && joint.friction === 0)
  );
}

function lossReport(input: RealismInput, record: EngineLosses): LossReport | null {
  const { report, runtimes, dynamics, trace } = input;
  const cycle = report.lastCycle;
  const own = runtimes.filter((runtime) => ownsCylinder(record, runtime.cylinder));
  const lead = own[0];
  if (cycle === null || lead === undefined || report.meanTorqueNm === null) return null;
  // friction reads the listed cylinders; the mean torque is the whole crank's, so the MEPs are per the whole crank's displacement
  const displacement = own.reduce((total, runtime) => total + runtime.layout.displacementM3, 0);
  const crankDisplacement = runtimes
    .filter((runtime) => runtime.cylinder.crank === record.crank)
    .reduce((total, runtime) => total + runtime.layout.displacementM3, 0);
  const cycleRad = lead.cylinder.cycle === 'four_stroke' ? 4 * Math.PI : 2 * Math.PI;
  const peakPa = Math.max(...own.map((runtime) => runtime.curveAt(cycle.meanRpm).peakPa));
  const fmep = fmepAt(record, cycle.meanRpm, peakPa);
  const friction = (fmep.pa * displacement) / cycleRad;
  const brake = report.meanTorqueNm - friction;
  const governor = Object.values(dynamics.motors).find((motor) => motor.kind === 'speed' && motor.joint === record.crank);
  const series = governor === undefined ? undefined : trace.servoForce[governor.id];
  const governed = series === undefined ? null : meanOver(trace.times, series, cycle.fromS, cycle.toS);
  const crossCheck =
    governed !== null && governorIsOnlyLoad(dynamics, record.crank) && Math.abs(brake) > 0
      ? { governorMeanTorqueNm: governed, relativeDifference: Math.abs(Math.abs(governed) - Math.abs(brake)) / Math.abs(brake) }
      : null;
  const imep = (report.meanTorqueNm * cycleRad) / crankDisplacement;
  const effectiveFmep = (friction * cycleRad) / crankDisplacement;
  return {
    id: record.id,
    model: record.model.kind,
    source: record.model.source,
    crankJoint: record.crank,
    rpm: cycle.meanRpm,
    displacementCm3: crankDisplacement * 1e6,
    peakPressureBar: peakPa / 1e5,
    fmepBar: effectiveFmep / 1e5,
    frictionTorqueNm: friction,
    indicatedTorqueNm: report.meanTorqueNm,
    brakeTorqueNm: brake,
    brakePowerKW: (brake * cycle.meanRpm * 2 * Math.PI) / 60 / 1000,
    imepBar: imep / 1e5,
    bmepBar: (imep - effectiveFmep) / 1e5,
    mechanicalEfficiency: imep > 0 ? (imep - effectiveFmep) / imep : 0,
    governorCrossCheck: crossCheck,
    outsideValidatedRange: fmep.outsideRange,
    fmepClamped: fmep.clamped === true,
  };
}

function reciprocatingReports(input: RealismInput): ReciprocatingReport[] {
  const meanRpm = input.report.lastCycle?.meanRpm ?? 0;
  const omega = (meanRpm * 2 * Math.PI) / 60;
  return input.runtimes.flatMap((runtime) => {
    const [piston, rod] = [input.mass[runtime.layout.pistonBody], input.mass[runtime.layout.rodBody]];
    if (piston === undefined || rod === undefined) return [];
    const curve = runtime.curveAt(meanRpm);
    const { slider, pistonAreaM2 } = runtime.layout;
    const massKg = piston.mass + ROD_RECIPROCATING_SHARE * rod.mass;
    const gasPeak = (curve.peakPa - curve.ambientPa) * pistonAreaM2;
    const primary = massKg * slider.r * omega * omega;
    return [
      {
        cylinder: runtime.cylinder.id,
        pistonBody: runtime.layout.pistonBody,
        rodBody: runtime.layout.rodBody,
        reciprocatingMassKg: massKg,
        primaryForceN: primary,
        secondaryForceN: (primary * slider.r) / slider.l,
        gasPeakForceN: gasPeak,
        inertiaToGasRatio: gasPeak > 0 ? primary / gasPeak : 0,
        massDefaulted: piston.densityDefaulted || rod.densityDefaulted,
      },
    ];
  });
}

function accuracyOf(input: RealismInput, losses: LossReport | null, record: EngineLosses | undefined): Record<string, Accuracy> {
  const { report, runtimes } = input;
  const rpm = report.lastCycle?.meanRpm ?? 0;
  const origin = combustionOrigin(
    runtimes.map((runtime) => runtime.cylinder.model),
    rpm,
  );
  const calibrated = origin === 'calibrated';
  const gasBand: AccuracyBand = calibrated ? { rel: CALIBRATION_BAND } : null;
  const gasBasis = calibrated
    ? `heat release calibrated to the brake target at this speed (tolerance ${CALIBRATION_BAND * 100} %); calibration is not validation evidence`
    : origin === 'input'
      ? 'gas pressure table given as input; its uncertainty is not stated'
      : 'single-zone combustion model away from its calibration speed: no quantitative uncertainty estimate (no breathing model)';
  const standing = [RIGID_BODY_WARNING];
  const gas = (): Accuracy => accuracy(gasBand, gasBasis, origin, { validationLevel: calibrated ? 1 : 0, warnings: standing });
  const entries: Record<string, Accuracy> = {};
  for (const key of ['meanTorqueNm', 'indicatedPowerKW', 'imepBar']) entries[key] = gas();
  if (record !== undefined && losses !== null) {
    const friction = fmepBand(record);
    const lossOrigin = frictionOrigin(record);
    entries['fmepBar'] = accuracy(friction.band, friction.basis, lossOrigin, { warnings: standing });
    entries['frictionTorqueNm'] = entries['fmepBar'];
    const bands = lossBands({
      calibrated,
      calibrationBand: CALIBRATION_BAND,
      gasBand,
      frictionBand: friction.band,
      indicated: losses.indicatedTorqueNm,
      friction: losses.frictionTorqueNm,
      brake: losses.brakeTorqueNm,
    });
    if (calibrated) {
      const indicatedBasis = 'calibrated brake value plus the friction band, root-sum-square (indicated = brake + friction)';
      for (const key of ['meanTorqueNm', 'indicatedPowerKW', 'imepBar'])
        entries[key] = accuracy(bands.indicated, indicatedBasis, origin, { validationLevel: 1, warnings: standing });
    }
    const brake = (): Accuracy =>
      accuracy(
        bands.brake,
        calibrated
          ? `brake value calibrated to the target at this speed (tolerance ${CALIBRATION_BAND * 100} %); calibration is not validation evidence`
          : 'gas side and friction band, root-sum-square',
        origin === 'input' ? 'input' : calibrated ? 'calibrated' : 'predicted',
        { validationLevel: calibrated ? 1 : 0, warnings: standing },
      );
    for (const key of ['brakeTorqueNm', 'brakePowerKW', 'bmepBar']) entries[key] = brake();
    entries['mechanicalEfficiency'] = accuracy(
      efficiencyBand(friction.band, losses.fmepBar, losses.imepBar),
      `${friction.basis}; eta = 1 - FMEP / IMEP, band rel(FMEP) (FMEP / IMEP) / eta`,
      lossOrigin,
      { warnings: standing },
    );
  }
  if (report.speedRipple !== null)
    entries['speedRipple'] = accuracy(
      null,
      'speed ripple of the simulated rigid crank; the analytic dE / (I w²) is its cross-check',
      'predicted',
      { warnings: standing },
    );
  if (report.energyClosure !== null)
    entries['energyClosure'] = accuracy(
      { abs: report.energyClosure.gate, unit: 'ratio' },
      'solver self-check against the pressure-model loop integral; the gate is the named 0.5 %',
      'verification',
      { validationLevel: 1 },
    );
  const loadsBand = null;
  entries['peakReactionForces'] = accuracy(
    loadsBand,
    'rigid-body reactions inherit the bands of the gas pressure and the masses; none is stated',
    'predicted',
    { warnings: [...standing, 'masses on the default density make the loads unverified (FPR_MASS_DEFAULTED)'] },
  );
  return entries;
}

function plausibilityFindings(input: RealismInput, losses: LossReport | null): PlausibilityFinding[] {
  const found: PlausibilityFinding[] = [];
  const { runtimes, dynamics } = input;
  for (const runtime of runtimes) {
    const { cylinder } = runtime;
    const model = cylinder.model;
    if (model.kind === 'table') continue;
    const curve = runtime.curveAt(input.report.lastCycle?.meanRpm ?? 1000);
    const cycleDeg = curve.cycleDeg;
    found.push(
      ...outsideBand(
        'peakPressureAngle',
        degreesAfterTdc(curve.peakAngleDeg, cycleDeg),
        PEAK_ANGLE_BAND_DEG,
        'deg ATDC',
        'MBT target near 15 deg ATDC [E-R16], tolerance +-10 deg named default',
        [cylinder.id],
        'change the burn phasing (ca50Deg / startDeg)',
      ),
    );
    const burn = model.kind === 'wiebe' ? model : model.burn;
    const ca50 = 'ca50Deg' in burn ? burn.ca50Deg : burn.startDeg + burn.durationDeg * (Math.LN2 / burn.a) ** (1 / (burn.m + 1));
    found.push(
      ...outsideBand(
        'ca50',
        ca50,
        CA50_BAND_DEG,
        'deg ATDC',
        'MBT target 8-10 deg ATDC [E-R16], tolerance +-5 deg named default (a fixed-spark aero engine can legitimately sit outside)',
        [cylinder.id],
        'check the burn phasing against the real spark timing',
      ),
    );
  }
  if (losses !== null)
    found.push(
      ...outsideBand(
        'mechanicalEfficiency',
        losses.mechanicalEfficiency,
        MECHANICAL_EFFICIENCY_BAND,
        '',
        'named default band; real engines reach about 0.85-0.90 at rated speed [E-R11]',
        [losses.id],
        'check the friction model (set_engine_losses) and the calibration target',
      ),
    );
  for (const propeller of Object.values(dynamics.propellers)) {
    const gear = Object.values(dynamics.gears).find((candidate) => candidate.driven === propeller.joint);
    if (gear === undefined || !isRotaxReduction(gear.ratio)) continue;
    const joint = dynamics.joints[propeller.joint];
    const body = input.mass[joint?.child ?? ''];
    const inertia =
      propeller.inertiaKgM2 ??
      (joint === undefined || body === undefined
        ? undefined
        : inertiaAboutAxis(body, scale3(joint.anchor, input.metresPerUnit), joint.axis));
    if (inertia !== undefined)
      found.push(
        ...outsideBand(
          'propellerInertia',
          inertia,
          ROTAX_PROPELLER_INERTIA_BAND,
          'kg·m²',
          'Rotax 912 installation manual limit 0.15-0.60 kg·m² [E-R4]',
          [propeller.id],
          'check the propeller inertia or the engine class',
        ),
      );
    const torque = input.propellerTorqueNm[propeller.id];
    if (torque !== undefined)
      found.push(
        ...outsideBand(
          'propellerTorque',
          Math.abs(torque),
          [0, ROTAX_MAX_PROPELLER_TORQUE_NM],
          'N·m',
          'Rotax 912 S / ULS limit 315 N·m at the propeller [E-R4]',
          [propeller.id],
          'check the engine torque and the gear ratio',
        ),
      );
  }
  for (const reciprocating of reciprocatingReports(input))
    if (reciprocating.massDefaulted)
      found.push({
        code: 'FPR_UNREALISTIC',
        status: 'warn',
        quantity: 'reciprocatingMass',
        value: reciprocating.reciprocatingMassKg,
        band: [0, 0],
        unit: 'kg',
        basis: 'named default: steel 7850 kg/m³ is used when no material is assigned (FPR_MASS_DEFAULTED)',
        ids: [reciprocating.pistonBody, reciprocating.rodBody],
        message: `reciprocating mass ${reciprocating.reciprocatingMassKg.toPrecision(4)} kg of '${reciprocating.cylinder}' is on the default density: assign sourced materials (al_4032 piston, steel_4340 rod); inertia loads are unverified`,
      });
  return found;
}

/** The realism section of an engine report, or null when the run has no full cycle to evaluate. */
export function realismData(input: RealismInput): RealismData | null {
  if (input.report.lastCycle === null) return null;
  const crank = input.report.crankJoint;
  const record = Object.values(input.dynamics.losses ?? {}).find((candidate) => candidate.crank === crank);
  const losses = record === undefined ? null : lossReport(input, record);
  const plausibility = plausibilityFindings(input, losses);
  return {
    losses,
    reciprocating: reciprocatingReports(input),
    accuracy: accuracyOf(input, losses, record),
    plausibility,
    warnings: [
      ...plausibility.map((item) => `${item.code}: ${item.message}`),
      ...(losses?.fmepClamped === true
        ? [
            `FPR_UNREALISTIC: the ${losses.model} friction constants give a negative FMEP at ${losses.rpm.toFixed(0)} rpm; it was clamped to 0 (check the constants)`,
          ]
        : []),
    ],
  };
}
