/** simulate_motion's `data.flight`: the rotor and drag laws re-evaluated on the recorded body states (the same functions the engine applied). */

import type { BodyKinematics, SimulationTrace } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { len3 } from '@lib/vec3';
import type { FlightRuntime } from './flightLoads';
import { bodyDragForce, rotorOutput, STATIC_ADVANCE_RATIO_LIMIT, type RotorOutput } from './rotorLaw';

interface RotorResult {
  readonly body: string;
  readonly rpm: number;
  readonly spin: 'cw' | 'ccw';
  readonly coefficients: 'static' | 'table';
  /** Values at the last sample: N, N·m, W. */
  readonly thrustN: number;
  readonly torqueNm: number;
  readonly powerW: number;
  readonly advanceRatio: { readonly min: number; readonly max: number; readonly final: number };
  /** Samples where J was outside the validated range (table ends, or |J| > 0.05 for a static pair). */
  readonly outsideRangeSamples: number;
}

export interface FlightData {
  readonly rotors: Record<string, RotorResult>;
  /** Per body with drag: speed of the centre of mass and drag force magnitude, m/s and N. */
  readonly bodyDrag: Record<string, { readonly finalSpeedMps: number; readonly finalForceN: number; readonly peakForceN: number }>;
  readonly series?: {
    readonly times: number[];
    readonly rotorThrust: Record<string, number[]>;
    readonly rotorPower: Record<string, number[]>;
    readonly advanceRatio: Record<string, number[]>;
    readonly dragForce: Record<string, number[]>;
  };
}

const last = <T>(values: readonly T[]): T | undefined => values[values.length - 1];

/** Recorded state of `bodyId` at every sample, or null when the engine did not record its velocity. */
function statesOf(trace: SimulationTrace, bodyId: string): BodyKinematics[] | null {
  const velocity = trace.bodyVelocity?.[bodyId];
  const position = trace.bodyPosition[bodyId] ?? [];
  const orientation = trace.bodyOrientation[bodyId] ?? [];
  if (velocity === undefined) return null;
  return trace.times.map((_, k) => ({
    position: position[k] ?? [0, 0, 0],
    orientation: orientation[k] ?? [1, 0, 0, 0],
    linearVelocity: velocity.linear[k] ?? [0, 0, 0],
    angularVelocity: velocity.angular[k] ?? [0, 0, 0],
  }));
}

/** `data.flight` of a run and its warnings (FLT_OUTSIDE_VALIDATED_RANGE, the energy balance not counting the flight loads). */
export function flightData(
  runtime: FlightRuntime,
  trace: SimulationTrace,
  options: { readonly series: boolean; readonly energy: boolean },
): { readonly data: FlightData; readonly warnings: string[] } {
  const warnings: string[] = [];
  const states = new Map(runtime.bodies.map((id) => [id, statesOf(trace, id)]));
  const missing = runtime.bodies.filter((id) => states.get(id) === null);
  if (missing.length > 0)
    warnings.push(
      `the physics engine recorded no velocity for ${missing.map((id) => `'${id}'`).join(', ')}: their flight loads are not reported`,
    );
  const outputs: Record<string, RotorOutput[]> = {};
  const rotors: Record<string, RotorResult> = {};
  for (const rotor of runtime.rotors) {
    const samples = states.get(rotor.rotor.bodyId) ?? null;
    if (samples === null) continue;
    const series = samples.map((state) => rotorOutput(rotor, state));
    const end = last(series);
    if (end === undefined) continue;
    outputs[rotor.rotor.id] = series;
    const js = series.map((output) => output.advanceRatio);
    const outside = series.filter((output) => output.outsideRange).length;
    const range = { min: Math.min(...js), max: Math.max(...js), final: end.advanceRatio };
    rotors[rotor.rotor.id] = {
      body: rotor.rotor.bodyId,
      rpm: rotor.rotor.rpm,
      spin: rotor.rotor.spin,
      coefficients: rotor.law.kind,
      thrustN: end.thrust,
      torqueNm: end.torque,
      powerW: end.power,
      advanceRatio: range,
      outsideRangeSamples: outside,
    };
    if (outside > 0) {
      const coefficients = rotor.rotor.coefficients;
      const validated =
        coefficients.kind === 'static'
          ? `a static pair is valid at |J| <= ${STATIC_ADVANCE_RATIO_LIMIT}`
          : `its table covers J ${Math.min(...coefficients.points.map((point) => point[0]))} to ${Math.max(...coefficients.points.map((point) => point[0]))}, the end values are held`;
      warnings.push(
        `FLT_OUTSIDE_VALIDATED_RANGE: rotor '${rotor.rotor.id}' runs at J ${range.min.toFixed(3)} to ${range.max.toFixed(3)} (${outside} of ${series.length} samples outside: ${validated})`,
      );
    }
  }
  const dragSeries: Record<string, number[]> = {};
  const bodyDrag: FlightData['bodyDrag'] = {};
  for (const drag of runtime.drags) {
    const samples = states.get(drag.bodyId) ?? null;
    if (samples === null) continue;
    const forces = samples.map((state) => len3(bodyDragForce(drag, state)));
    const speed = len3(last(samples)?.linearVelocity ?? ([0, 0, 0] as Vec3));
    dragSeries[drag.bodyId] = forces;
    bodyDrag[drag.bodyId] = { finalSpeedMps: speed, finalForceN: forces.at(-1) ?? 0, peakForceN: Math.max(0, ...forces) };
  }
  if (options.energy)
    warnings.push(
      'FLT_ENERGY_UNCOUNTED: the work of rotor thrust / torque and body drag on the bodies is not in the energy balance (it shows in balanceErrorJ)',
    );
  const pick = (read: (output: RotorOutput) => number): Record<string, number[]> =>
    Object.fromEntries(Object.entries(outputs).map(([id, series]) => [id, series.map(read)]));
  const data: FlightData = {
    rotors,
    bodyDrag,
    ...(options.series
      ? {
          series: {
            times: trace.times,
            rotorThrust: pick((output) => output.thrust),
            rotorPower: pick((output) => output.power),
            advanceRatio: pick((output) => output.advanceRatio),
            dragForce: dragSeries,
          },
        }
      : {}),
  };
  return { data, warnings };
}

/** One sentence per rotor and drag body for the run summary. */
export function flightSummary(data: FlightData): string {
  const digits = (value: number): string => value.toPrecision(4);
  return [
    ...Object.entries(data.rotors).map(
      ([id, rotor]) =>
        `Rotor ${id} (body ${rotor.body}): thrust ${digits(rotor.thrustN)} N, torque ${digits(rotor.torqueNm)} N·m, ${digits(rotor.powerW)} W at the end, J ${rotor.advanceRatio.min.toFixed(3)} to ${rotor.advanceRatio.max.toFixed(3)}.`,
    ),
    ...Object.entries(data.bodyDrag).map(
      ([id, drag]) =>
        `Drag of body ${id}: ${digits(drag.finalForceN)} N at ${digits(drag.finalSpeedMps)} m/s at the end (peak ${digits(drag.peakForceN)} N).`,
    ),
  ].join(' ');
}
