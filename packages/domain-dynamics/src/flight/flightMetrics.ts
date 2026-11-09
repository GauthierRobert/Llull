/**
 * Numbers of a flight run (FR-FLT-07 / 08): attitude and rate peaks, tracking error, recovery after each event, saturation, thrust margin,
 * shaft energy and power, per-rotor final state with the momentum-theory figure of merit, and the validity of the rotor coefficients. Peaks,
 * integrals and counts come from the flight block's per-step aux state (exact); recovery and the series from the recorded samples.
 */

import type { Quaternion, Vec3 } from '@core/model/vectors';
import { dot3, len3, sub3 } from '@lib/vec3';
import { aeroMetrics, type AeroSurfaceMetrics } from './aeroMetrics';
import { batteryMetrics, batteryWarnings, type BatteryMetrics } from './batteryMetrics';
import { mixerRow, NOT_CONTROLLED, powerBase, ROTOR, rotorSlot, setpointAt, SLOT, tiltOf } from './flightBlock';
import { POWER } from './powerBlock';
import { offsetAt, type FlightRun } from './flightRun';
import { rotateInverse } from './frames';
import { STATIC_ADVANCE_RATIO_LIMIT, validatedRange } from './rotorLaw';

const DEG = 180 / Math.PI;

interface FlightEvent {
  readonly kind: 'setpoint' | 'gust';
  readonly timeS: number;
  /** s from the event until the position error stays inside the scenario's settle band (until the next event); null = never. */
  readonly recoveryTimeS: number | null;
  readonly peakErrorM: number;
}

interface RotorMetrics {
  readonly controlled: boolean;
  readonly finalRpm: number;
  readonly finalThrustN: number;
  readonly finalShaftPowerW: number;
  readonly finalAdvanceRatio: number;
  /** Momentum-theory ideal power T^1.5 / sqrt(2ρA) at the final state, W. */
  readonly idealPowerW: number;
  /** idealPowerW / finalShaftPowerW; null outside hover (|J| > 0.05) or without power. */
  readonly figureOfMerit: number | null;
  readonly advanceRatio: { readonly min: number; readonly max: number };
  readonly validatedRange: readonly [number, number];
  /** Share of the physics steps with J outside validatedRange. */
  readonly outsideFraction: number;
}

export interface FlightMetrics {
  readonly scenarioId: string;
  readonly controllerId: string | null;
  readonly engine: string;
  readonly durationS: number;
  readonly timestepS: number;
  readonly sampleIntervalS: number;
  readonly samples: number;
  readonly vehicle: { readonly bodyId: string; readonly massKg: number; readonly inertiaKgM2: readonly [number, number, number] };
  readonly attitude: {
    readonly maxTiltDeg: number;
    readonly maxTiltTimeS: number;
    readonly maxRateDegS: number;
    readonly maxRateTimeS: number;
    readonly final: { readonly rollDeg: number; readonly pitchDeg: number; readonly yawDeg: number };
  };
  readonly tracking: {
    readonly rmsPositionErrorM: number;
    readonly maxPositionErrorM: number;
    readonly maxPositionErrorTimeS: number;
    readonly finalPositionErrorM: number;
    readonly finalYawErrorDeg: number;
    readonly finalOffsetM: Vec3;
  };
  readonly events: readonly FlightEvent[];
  /** Largest recovery time over the events; null when there is none or one never recovered (see events). */
  readonly recoveryTimeS: number | null;
  readonly control: {
    readonly rateHz: number;
    readonly ticks: number;
    readonly saturationFraction: number;
    /** Σ thrust at maxRpm along the thrust axis, N. */
    readonly maxThrustN: number;
    readonly thrustToWeight: number;
    /** 1 - weight / maxThrustN: share of the maximum thrust left at hover. */
    readonly thrustMargin: number;
  } | null;
  readonly power: {
    readonly shaftEnergyJ: number;
    readonly meanShaftPowerW: number;
    readonly peakShaftPowerW: number;
    readonly peakShaftPowerTimeS: number;
    readonly finalShaftPowerW: number;
  };
  readonly rotors: Readonly<Record<string, RotorMetrics>>;
  /** Per powertrain id (13 FLT M3); empty without a powertrain. */
  readonly battery: Readonly<Record<string, BatteryMetrics>>;
  /** Per aero surface (13 FLT M4): empty without one. */
  readonly aero: Readonly<Record<string, AeroSurfaceMetrics>>;
  /** First time the thrust axis tilted past 90° under a controller; null = it did not. */
  readonly divergedAtS: number | null;
  readonly defaulted: readonly string[];
  readonly unverified: boolean;
  readonly warnings: readonly string[];
}

/** Roll, pitch, yaw (deg, Z-Y-X Tait-Bryan) of a rotation from the start attitude. */
export function eulerDeg(q: Quaternion): { rollDeg: number; pitchDeg: number; yawDeg: number } {
  const [w, x, y, z] = q;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.min(1, Math.max(-1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { rollDeg: roll * DEG, pitchDeg: pitch * DEG, yawDeg: yaw * DEG };
}

/** Accessors of one run's samples. */
function samplesOf(run: FlightRun): {
  readonly count: number;
  time(k: number): number;
  aux(slot: number, k: number): number;
  orientation(k: number): Quaternion;
  velocity(k: number): Vec3;
  angularVelocity(k: number): Vec3;
  error(k: number): number;
} {
  const { trace, loop, auxOffset } = run;
  const id = loop.vehicleId;
  return {
    count: trace.times.length,
    time: (k) => trace.times[k] ?? 0,
    aux: (slot, k) => trace.aux?.[auxOffset + slot]?.[k] ?? 0,
    orientation: (k) => trace.bodyOrientation[id]?.[k] ?? [1, 0, 0, 0],
    velocity: (k) => trace.bodyVelocity?.[id]?.linear[k] ?? [0, 0, 0],
    angularVelocity: (k) => trace.bodyVelocity?.[id]?.angular[k] ?? [0, 0, 0],
    error: (k) => len3(sub3(setpointAt(loop.scenario, trace.times[k] ?? 0).position, offsetAt(run, k))),
  };
}

/** Events of the scenario (set-point changes after t = 0, gust starts) with their recovery from the samples. */
function eventsOf(run: FlightRun, samples: ReturnType<typeof samplesOf>): FlightEvent[] {
  const { scenario } = run;
  const marks = [
    ...scenario.setpoints.filter((setpoint) => setpoint.t > 0).map((setpoint) => ({ kind: 'setpoint' as const, timeS: setpoint.t })),
    ...scenario.wind.gusts.map((gust) => ({ kind: 'gust' as const, timeS: gust.startS })),
  ].sort((a, b) => a.timeS - b.timeS);
  return marks.map((mark, index) => {
    const end = marks.find((other, j) => j > index && other.timeS > mark.timeS)?.timeS ?? Infinity;
    let peak = 0;
    let lastOutside = -1;
    let first = -1;
    let last = -1;
    for (let k = 0; k < samples.count; k++) {
      const t = samples.time(k);
      if (t < mark.timeS - 1e-9 || t >= end - 1e-9) continue;
      if (first < 0) first = k;
      last = k;
      const error = samples.error(k);
      peak = Math.max(peak, error);
      if (error > scenario.settleBandM) lastOutside = k;
    }
    const recovered = first >= 0 && lastOutside < last;
    const recoveryTimeS = !recovered ? null : lastOutside < 0 ? 0 : samples.time(lastOutside + 1) - mark.timeS;
    return { ...mark, recoveryTimeS, peakErrorM: peak };
  });
}

/** The numbers of `run`. */
export function flightMetrics(run: FlightRun): FlightMetrics {
  const { loop, scenario, controller } = run;
  const samples = samplesOf(run);
  const lastK = samples.count - 1;
  const final = (slot: number): number => samples.aux(slot, lastK);
  const duration = samples.time(lastK);
  const weight = run.massKg * run.gravityMps2;
  const rotors: Record<string, RotorMetrics> = {};
  const warnings: string[] = [];
  const physicsSteps = Math.max(1, final(SLOT.step));
  loop.rotors.forEach((rotor, i) => {
    const thrust = final(rotorSlot(i, ROTOR.thrust));
    const power = final(rotorSlot(i, ROTOR.power));
    const j = final(rotorSlot(i, ROTOR.advanceRatio));
    const area = Math.PI * (rotor.rotor.diameter / 2) ** 2;
    const ideal = thrust > 0 ? thrust ** 1.5 / Math.sqrt(2 * rotor.rotor.airDensity * area) : 0;
    const outside = final(rotorSlot(i, ROTOR.outsideSteps));
    const range = validatedRange(rotor);
    rotors[rotor.rotor.id] = {
      controlled: mixerRow(loop, i) !== NOT_CONTROLLED,
      finalRpm: final(rotorSlot(i, ROTOR.rpm)),
      finalThrustN: thrust,
      finalShaftPowerW: power,
      finalAdvanceRatio: j,
      idealPowerW: ideal,
      figureOfMerit: power > 0 && Math.abs(j) <= STATIC_ADVANCE_RATIO_LIMIT ? ideal / power : null,
      advanceRatio: { min: final(rotorSlot(i, ROTOR.minJ)), max: final(rotorSlot(i, ROTOR.maxJ)) },
      validatedRange: range,
      outsideFraction: outside / physicsSteps,
    };
    if (outside > 0)
      warnings.push(
        `FLT_OUTSIDE_VALIDATED_RANGE: rotor '${rotor.rotor.id}' ran at J ${final(rotorSlot(i, ROTOR.minJ)).toPrecision(3)} to ${final(rotorSlot(i, ROTOR.maxJ)).toPrecision(3)}, outside its validated range [${range.map((value) => value.toPrecision(3)).join(', ')}] for ${((100 * outside) / physicsSteps).toPrecision(3)} % of the steps`,
      );
  });
  const battery = Object.fromEntries(
    loop.power.map((feed, index) => [feed.powertrain.id, batteryMetrics(feed, index, loop.rotors.length, final, duration, physicsSteps)]),
  );
  for (const [id, entry] of Object.entries(battery)) warnings.push(...batteryWarnings(id, entry));
  const aero = aeroMetrics(loop, final, physicsSteps, run.staleAero);
  warnings.push(...aero.warnings);
  const runtime = loop.control?.runtime ?? null;
  const maxThrustN =
    runtime === null
      ? 0
      : loop.rotors.reduce((sum, rotor, i) => {
          const row = mixerRow(loop, i);
          return row < 0 ? sum : sum + (runtime.maxThrust[row] ?? 0) * dot3(rotor.axis, runtime.thrustAxis);
        }, 0);
  const ticks = final(SLOT.ticks);
  const events = eventsOf(run, samples);
  const recoveries = events.map((event) => event.recoveryTimeS);
  const recoveryTimeS =
    events.length === 0 || recoveries.some((value) => value === null)
      ? null
      : Math.max(...recoveries.filter((value): value is number => value !== null));
  const yawSetpoint = setpointAt(scenario, duration).yawDeg;
  const attitudeFinal = eulerDeg(samples.orientation(lastK));
  const divergedTime = final(SLOT.divergedTime);
  const finalOffset = offsetAt(run, lastK);
  const inertia = run.inertia;
  return {
    scenarioId: scenario.id,
    controllerId: controller?.id ?? null,
    engine: run.engine,
    durationS: duration,
    timestepS: run.timestep,
    sampleIntervalS: run.sampleInterval,
    samples: samples.count,
    vehicle: { bodyId: loop.vehicleId, massKg: run.massKg, inertiaKgM2: [inertia[0][0], inertia[1][1], inertia[2][2]] },
    attitude: {
      maxTiltDeg: final(SLOT.maxTilt) * DEG,
      maxTiltTimeS: final(SLOT.maxTiltTime),
      maxRateDegS: final(SLOT.maxRate) * DEG,
      maxRateTimeS: final(SLOT.maxRateTime),
      final: attitudeFinal,
    },
    tracking: {
      rmsPositionErrorM: Math.sqrt(final(SLOT.errorSquaredIntegral) / Math.max(duration, run.timestep)),
      maxPositionErrorM: final(SLOT.maxError),
      maxPositionErrorTimeS: final(SLOT.maxErrorTime),
      finalPositionErrorM: samples.error(lastK),
      finalYawErrorDeg: ((((attitudeFinal.yawDeg - yawSetpoint) % 360) + 540) % 360) - 180,
      finalOffsetM: finalOffset,
    },
    events,
    recoveryTimeS,
    control:
      runtime === null || controller === null
        ? null
        : {
            rateHz: controller.rateHz,
            ticks,
            saturationFraction: ticks > 0 ? final(SLOT.saturatedTicks) / ticks : 0,
            maxThrustN,
            thrustToWeight: weight > 0 ? maxThrustN / weight : Infinity,
            thrustMargin: maxThrustN > 0 ? 1 - weight / maxThrustN : -Infinity,
          },
    power: {
      shaftEnergyJ: final(SLOT.shaftEnergy),
      meanShaftPowerW: duration > 0 ? final(SLOT.shaftEnergy) / duration : 0,
      peakShaftPowerW: final(SLOT.peakPower),
      peakShaftPowerTimeS: final(SLOT.peakPowerTime),
      finalShaftPowerW: loop.rotors.reduce((sum, _, i) => sum + final(rotorSlot(i, ROTOR.power)), 0),
    },
    rotors,
    battery,
    aero: aero.surfaces,
    divergedAtS: divergedTime >= 0 ? divergedTime : null,
    defaulted: run.defaulted,
    unverified: run.defaulted.length > 0,
    warnings,
  };
}

/** Per-sample series of a run (detail "series"). */
export function flightSeries(run: FlightRun): Record<string, unknown> {
  const samples = samplesOf(run);
  const ks = Array.from({ length: samples.count }, (_, k) => k);
  const round = (value: number): number => Number(value.toPrecision(7));
  const vec = (value: Vec3): number[] => value.map(round);
  return {
    times: ks.map(samples.time),
    positionM: ks.map((k) => vec(offsetAt(run, k))),
    setpointM: ks.map((k) => vec(setpointAt(run.scenario, samples.time(k)).position)),
    velocityMps: ks.map((k) => vec(samples.velocity(k))),
    attitudeDeg: ks.map((k) => {
      const e = eulerDeg(samples.orientation(k));
      return [round(e.rollDeg), round(e.pitchDeg), round(e.yawDeg)];
    }),
    tiltDeg: ks.map((k) =>
      round(
        tiltOf(run.loop, {
          position: [0, 0, 0],
          orientation: samples.orientation(k),
          linearVelocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
        }) * DEG,
      ),
    ),
    bodyRateDegS: ks.map((k) =>
      vec(rotateInverse(samples.orientation(k), samples.angularVelocity(k)).map((w) => w * DEG) as unknown as Vec3),
    ),
    windMps: ks.map((k) => vec(run.loop.wind(samples.time(k)))),
    battery: Object.fromEntries(
      run.loop.power.map((feed, p) => {
        const at = (field: number, k: number): number => round(samples.aux(powerBase(run.loop.rotors.length, p) + field, k));
        return [
          feed.powertrain.id,
          {
            soc: ks.map((k) => at(POWER.soc, k)),
            voltageV: ks.map((k) => at(POWER.voltage, k)),
            currentA: ks.map((k) => at(POWER.current, k)),
          },
        ];
      }),
    ),
    rotors: Object.fromEntries(
      run.loop.rotors.map((rotor, i) => [
        rotor.rotor.id,
        {
          rpm: ks.map((k) => round(samples.aux(rotorSlot(i, ROTOR.rpm), k))),
          thrustN: ks.map((k) => round(samples.aux(rotorSlot(i, ROTOR.thrust), k))),
          shaftPowerW: ks.map((k) => round(samples.aux(rotorSlot(i, ROTOR.power), k))),
        },
      ]),
    ),
  };
}
