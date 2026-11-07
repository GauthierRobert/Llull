/**
 * 13 FLT validation cases through the command layer (add_rotor / set_body_drag + simulate_motion on MuJoCo), each against a closed form or a
 * UIUC propeller row (docs/aerospace/13-flight-dynamics/validation/README.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { FlightData } from '@dynamics/flight/flightReport';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { airframe, G, rotorParams, simulate, step } from './flightFixture';

beforeAll(async () => {
  setPhysicsEngine(await createMujocoPhysics());
});
afterAll(() => setPhysicsEngine(null));

type Quaternion = readonly [number, number, number, number];
interface Run {
  flight: FlightData;
  warnings: string[];
  poses: { bodies: Record<string, { position: [number, number, number][]; orientation: Quaternion[] }> };
}
const run = (doc: CadDocument, params: Record<string, unknown>): Run => simulate(doc, { detail: 'poses', ...params }) as unknown as Run;
const rel = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);
const RHO = 1.225;
const D = 0.254;

/** Thrust coefficient giving `thrust` N at `rpm` for the 0.254 m rotor at ISA density. */
const ctFor = (thrust: number, rpm: number): number => thrust / (RHO * (rpm / 60) ** 2 * D ** 4);
/** Power coefficient giving reaction torque `torque` N·m at `rpm`. */
const cpFor = (torque: number, rpm: number): number => (torque * 2 * Math.PI) / (RHO * (rpm / 60) ** 2 * D ** 5);

const finalPose = (data: Run): { position: [number, number, number]; orientation: Quaternion } => {
  const frame = data.poses.bodies['frame'];
  return { position: frame?.position.at(-1) ?? [NaN, NaN, NaN], orientation: frame?.orientation.at(-1) ?? [NaN, NaN, NaN, NaN] };
};

/** q ⊗ (0, w) / 2: body-frame angular velocity w. */
function quaternionRate(q: Quaternion, w: readonly [number, number, number]): Quaternion {
  const [qw, qx, qy, qz] = q;
  return [
    0.5 * (-qx * w[0] - qy * w[1] - qz * w[2]),
    0.5 * (qw * w[0] + qy * w[2] - qz * w[1]),
    0.5 * (qw * w[1] + qz * w[0] - qx * w[2]),
    0.5 * (qw * w[2] + qx * w[1] - qy * w[0]),
  ];
}

/** Orientation at `duration` from the closed-form body angular velocity `omega(t)`, RK4 with 20 000 steps. */
function orientationOf(omega: (t: number) => readonly [number, number, number], duration: number): Quaternion {
  const steps = 20000;
  const h = duration / steps;
  let q: Quaternion = [1, 0, 0, 0];
  const add = (a: Quaternion, b: Quaternion, s: number): Quaternion => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
  for (let k = 0; k < steps; k++) {
    const t = k * h;
    const k1 = quaternionRate(q, omega(t));
    const k2 = quaternionRate(add(q, k1, h / 2), omega(t + h / 2));
    const k3 = quaternionRate(add(q, k2, h / 2), omega(t + h / 2));
    const k4 = quaternionRate(add(q, k3, h), omega(t + h));
    q = [0, 1, 2, 3].map(
      (i) => (q[i] ?? 0) + (h / 6) * ((k1[i] ?? 0) + 2 * (k2[i] ?? 0) + 2 * (k3[i] ?? 0) + (k4[i] ?? 0)),
    ) as unknown as Quaternion;
  }
  return q;
}

describe('13 FLT validation cases (FLT-M1)', () => {
  it('VC-FLT-01: a free body carrying an idle rotor falls z = -g t²/2 (the body-state pass does not perturb the integration)', () => {
    const doc = step(airframe(1, [0.01, 0.01, 0.01], [0, 0, -G]), 'add_rotor', rotorParams({ rpm: 0 })).doc;
    const data = run(doc, { duration: 2, sampleRate: 10 });
    expect(rel(finalPose(data).position[2], -19613.3)).toBeLessThan(1e-6);
  });

  it('VC-FLT-03: four rotors tilted 20° with total thrust m g / cos 20° accelerate the body at g tan 20° = 3.5693 m/s², attitude held', () => {
    const mass = 1.115;
    const tilt = (20 * Math.PI) / 180;
    const axis = [Math.sin(tilt), 0, Math.cos(tilt)];
    const ct = ctFor((mass * G) / (4 * Math.cos(tilt)), 6000);
    let doc = airframe(mass, [0.01, 0.012, 0.02], [0, 0, -G]);
    const hubs: [number, number, number, 'cw' | 'ccw'][] = [
      [150, 150, 0, 'ccw'],
      [-150, -150, 0, 'ccw'],
      [150, -150, 0, 'cw'],
      [-150, 150, 0, 'cw'],
    ];
    for (const [x, y, z, spin] of hubs)
      doc = step(doc, 'add_rotor', rotorParams({ hub: [x, y, z], axis, spin, thrustCoefficient: ct, powerCoefficient: 0.04 })).doc;
    const data = run(doc, { duration: 2, sampleRate: 10 });
    const { position, orientation } = finalPose(data);
    const horizontal = (2 * position[0]) / 1000 / 4;
    expect(rel(horizontal, 9.80665 * Math.tan(tilt))).toBeLessThan(1e-3);
    expect(rel(horizontal, 3.5693)).toBeLessThan(1e-3);
    expect(Math.abs((2 * position[2]) / 1000 / 4)).toBeLessThan(1e-3);
    expect(Math.abs(orientation[0] - 1)).toBeLessThan(1e-9);
    // the static pair is validated at J = 0 only; the run picks up axial inflow
    expect(data.warnings.some((w) => w.startsWith('FLT_OUTSIDE_VALIDATED_RANGE'))).toBe(true);
  });

  it('VC-FLT-04: APC SF 10x4.7 static at 6528 rpm (Ct 0.1299, Cp 0.0531) gives T = 7.8404 N, P = 88.570 W', () => {
    const added = step(
      airframe(1, [0.01, 0.01, 0.01], [0, 0, 0]),
      'add_rotor',
      rotorParams({ rpm: 6528, thrustCoefficient: 0.1299, powerCoefficient: 0.0531, source: 'UIUC apcsf_10x4.7_static_kt0835 [S1]' }),
    );
    const data = run(added.doc, { duration: 0.05, sampleRate: 100, energy: true });
    const rotor = data.flight.rotors[added.id];
    expect(data.flight.series?.rotorThrust[added.id]).toHaveLength(6);
    expect(data.warnings).toContain(
      'FLT_ENERGY_UNCOUNTED: the work of rotor thrust / torque and body drag on the bodies is not in the energy balance (it shows in balanceErrorJ)',
    );
    expect((data as unknown as { summary: string }).summary).toContain(`Rotor ${added.id} (body frame): thrust 7.840 N`);
    expect(rel(rotor?.thrustN ?? 0, 7.8404)).toBeLessThan(5e-3);
    expect(rel(rotor?.powerW ?? 0, 88.57)).toBeLessThan(5e-3);
    expect(rotor?.coefficients).toBe('static');
  });

  it('VC-FLT-05: J from the body state; at V = 6.8078 m/s and 6023 rpm the UIUC table row J 0.267 gives Ct 0.0884, T = 4.5420 N', () => {
    const doc = airframe(1, [0.01, 0.01, 0.01], [0, 0, 0]);
    const slide = step(doc, 'add_body_joint', {
      kind: 'prismatic',
      child: 'frame',
      anchor: [0, 0, 0],
      axis: [0, 0, 1],
      initialVelocity: 6.8078,
    });
    const held = step(slide.doc, 'add_motor', { joint: slide.id, kind: 'speed', speedMps: 6.8078, maxForceN: 100 });
    const table = {
      points: [
        [0.095, 0.1171, 0.0511],
        [0.267, 0.0884, 0.0459],
        [0.453, 0.0532, 0.037],
        [0.477, 0.048, 0.0354],
      ],
      source: 'UIUC apcsf_10x4.7_rd0839_6023 [S2]',
      grade: 'A',
    };
    const rotor = step(held.doc, 'add_rotor', {
      ...rotorParams({ rpm: 6023, table }),
      thrustCoefficient: undefined,
      powerCoefficient: undefined,
      source: undefined,
    });
    const data = run(rotor.doc, { duration: 0.2, sampleRate: 50 });
    const out = data.flight.rotors[rotor.id];
    expect(out?.advanceRatio.final).toBeCloseTo(0.267, 4);
    expect(rel(out?.thrustN ?? 0, 4.542)).toBeLessThan(5e-3);
    expect(out?.outsideRangeSamples).toBe(0);
    expect(data.warnings.some((w) => w.startsWith('FLT_OUTSIDE_VALIDATED_RANGE'))).toBe(false);
  });

  it('VC-FLT-08: a ccw rotor with reaction torque 0.01 N·m on Izz = 0.012 kg·m² yaws the body at -0.83333 rad/s²', () => {
    const doc = step(airframe(1, [0.02, 0.03, 0.012], [0, 0, 0]), 'add_rotor', rotorParams({ powerCoefficient: cpFor(0.01, 6000) })).doc;
    const data = run(doc, { duration: 1, sampleRate: 10 });
    const q = finalPose(data).orientation;
    const yawAcceleration = 2 * (2 * Math.atan2(q[3], q[0]));
    expect(rel(yawAcceleration, -0.01 / 0.012)).toBeLessThan(1e-6);
  });

  it('thrust stays in the body frame: an off-centre rotor pitches the body and its thrust turns with it (double integral of F R(θ(t)) ẑ)', () => {
    const force = 0.2;
    const arm = 0.1;
    const iyy = 0.01;
    const doc = step(
      airframe(1, [0.02, iyy, 0.015], [0, 0, 0]),
      'add_rotor',
      rotorParams({ hub: [100, 0, 0], thrustCoefficient: ctFor(force, 6000) }),
    ).doc;
    const duration = 1;
    const data = run(doc, { duration, sampleRate: 10 });
    // torque r × F = (0.1 x̂) × (0.2 ẑ) = -0.02 ŷ about a principal axis: θ(t) = -0.02 t² / (2 Iyy) about y
    const theta = (t: number): number => (-(force * arm) / iyy) * 0.5 * t * t;
    const q = finalPose(data).orientation;
    expect(2 * Math.atan2(q[2], q[0])).toBeCloseTo(theta(duration), 6);
    // x(T) = (F/m) ∫ (T - s) sin θ(s) ds, z(T) = (F/m) ∫ (T - s) cos θ(s) ds (Simpson)
    const n = 20000;
    const simpson = (f: (s: number) => number): number => {
      let sum = f(0) + f(duration);
      for (let k = 1; k < n; k++) sum += (k % 2 === 1 ? 4 : 2) * f((k * duration) / n);
      return (sum * duration) / (3 * n);
    };
    const x = force * simpson((s) => (duration - s) * Math.sin(theta(s)));
    const z = force * simpson((s) => (duration - s) * Math.cos(theta(s)));
    const { position } = finalPose(data);
    expect(rel(position[0] / 1000, x)).toBeLessThan(1e-5);
    expect(rel(position[2] / 1000, z)).toBeLessThan(1e-5);
  });

  it('gyroscopic precession: torque τ about x on a body with spin momentum h along z gives ω_x = (τ/h) sin Ωt, ω_y = (τ/h)(1 - cos Ωt), Ω = h/I', () => {
    const inertia = 0.01;
    const spinInertia = 1e-4;
    const rpm = 6000;
    const h = spinInertia * 2 * Math.PI * (rpm / 60);
    const torque = 0.02;
    let doc = airframe(1, [inertia, inertia, 0.015], [0, 0, 0]);
    doc = step(doc, 'add_rotor', rotorParams({ spinInertiaKgM2: spinInertia, id: 'spinner' })).doc;
    // a second rotor along x with no thrust: its reaction torque -τ x̂ is the applied torque (ccw: about -axis)
    doc = step(doc, 'add_rotor', rotorParams({ axis: [1, 0, 0], powerCoefficient: cpFor(torque, rpm), id: 'torquer' })).doc;
    const duration = 3;
    const data = run(doc, { duration, sampleRate: 10 });
    const rate = h / inertia;
    const tau = -torque;
    const expected = orientationOf((t) => [(tau / h) * Math.sin(rate * t), (tau / h) * (1 - Math.cos(rate * t)), 0], duration);
    const actual = finalPose(data).orientation;
    for (let i = 0; i < 4; i++) expect(Math.abs((actual[i] ?? 0) - (expected[i] ?? 0))).toBeLessThan(1e-5);
    // without the gyroscopic term the body would only roll: θ_x = τ t² / (2 I) = -9 rad; the precessed body turned < 2 rad in all
    expect(2 * Math.acos(Math.min(1, Math.abs(actual[0])))).toBeLessThan(2);
  });

  it('body drag: a falling body reaches v(t) = v_t tanh(g t / v_t), z(t) = -(v_t² / g) ln cosh(g t / v_t), v_t = sqrt(2 m g / (ρ CdA))', () => {
    const mass = 1;
    const cda = 0.1;
    const drag = step(airframe(mass, [0.01, 0.01, 0.01], [0, 0, -G]), 'set_body_drag', { body: 'frame', cdaM2: [0.3, 0.3, cda] });
    const duration = 3;
    const data = run(drag.doc, { duration, sampleRate: 10 });
    const terminal = Math.sqrt((2 * mass * G) / (RHO * cda));
    const z = -((terminal * terminal) / G) * Math.log(Math.cosh((G * duration) / terminal));
    expect(rel(finalPose(data).position[2] / 1000, z)).toBeLessThan(1e-5);
    const speed = terminal * Math.tanh((G * duration) / terminal);
    expect(rel(data.flight.bodyDrag['frame']?.finalSpeedMps ?? 0, speed)).toBeLessThan(1e-5);
    expect(rel(data.flight.bodyDrag['frame']?.finalForceN ?? 0, 0.5 * RHO * cda * speed * speed)).toBeLessThan(1e-5);
  });
});
