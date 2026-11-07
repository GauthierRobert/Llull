/** DRV-M0 spike (docs/physics/23-drives-physical-truth, TECHNICAL_SPEC §13): what MuJoCo 3.16 WASM offers the drives pack, pinned as regression guards. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

interface RawModel {
  readonly dof_frictionloss: Float64Array;
  readonly dof_armature: Float64Array;
  delete(): void;
}
interface RawData {
  readonly time: number;
  readonly qpos: Float64Array;
  readonly qvel: Float64Array;
  readonly qfrc_applied: Float64Array;
  readonly ctrl: Float64Array;
  readonly act: Float64Array;
  readonly ten_length: Float64Array;
  readonly nefc: number;
  readonly efc_type: Int32Array;
  readonly efc_id: Int32Array;
  readonly efc_force: Float64Array;
  delete(): void;
}
interface RawMujoco {
  readonly MjModel: { from_xml_string(xml: string): RawModel };
  readonly MjData: new (model: RawModel) => RawData;
  mj_step(model: RawModel, data: RawData): void;
  mj_setConst(model: RawModel, data: RawData): void;
}

let mj: RawMujoco;
beforeAll(async () => {
  const { default: loadMujoco } = (await import('@mujoco/mujoco')) as unknown as { default: () => Promise<RawMujoco> };
  mj = await loadMujoco();
});

/** mjtConstraint values read from `efc_type`. */
const CNSTR = { equality: 0, frictionDof: 1, limitJoint: 3, limitTendon: 4 } as const;

const option = (dt: number): string => `<option timestep="${dt}" gravity="0 0 0" integrator="implicitfast"/>`;
const inertial = (j: number): string => `<inertial pos="0 0 0" mass="1" diaginertia="${j} ${j} ${j}"/>`;
const hinge = (name: string, attrs = ''): string => `<joint name="${name}" type="hinge" axis="0 0 1" ${attrs}/>`;

function build(xml: string): { model: RawModel; data: RawData; step: (n: number) => void } {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  return {
    model,
    data,
    step: (n) => {
      for (let i = 0; i < n; i++) mj.mj_step(model, data);
    },
  };
}

const flat = '0.9999 0.9999 0.001';
const value = (array: Float64Array, index = 0): number => array[index] ?? Number.NaN;

const referencePath = 'docs/physics/23-drives-physical-truth/validation/drv_reference.json';

describe('OQ-DRV-01: dof_frictionloss written between steps (no recompile)', () => {
  const rotor = (joint: string): string =>
    `<mujoco>${option(1e-4)}<worldbody><body>${hinge('j', joint)}${inertial(0.01)}</body></worldbody></mujoco>`;

  it('a write is visible and acts at the next step: stick below the level, slip above it, stick again when raised', () => {
    const { model, data, step } = build(rotor(`frictionloss="2" solimpfriction="${flat}"`));
    data.qfrc_applied[0] = 1.5;
    step(1000);
    expect(Math.abs(value(data.qvel))).toBeLessThan(1e-3); // holds: 1.5 N m < 2 N m
    model.dof_frictionloss[0] = 0.5;
    expect(value(model.dof_frictionloss)).toBe(0.5);
    step(1000);
    expect(value(data.qvel)).toBeCloseTo(10, 2); // (1.5 - 0.5) / 0.01 * 0.1 s
    model.dof_frictionloss[0] = 3;
    data.qfrc_applied[0] = 0;
    step(2000);
    expect(Math.abs(value(data.qvel))).toBeLessThan(1e-6); // the raised level stops the rotor
    expect(data.efc_type[0]).toBe(CNSTR.frictionDof);
    expect(data.efc_id[0]).toBe(0);
  });

  it('hold at rest needs a flat impedance: the default solimpfriction creeps 1000x faster', () => {
    const creep = (joint: string): number => {
      const { data, step } = build(rotor(joint));
      data.qfrc_applied[0] = 1.5;
      step(5000);
      return Math.abs(value(data.qvel));
    };
    expect(creep('frictionloss="2"')).toBeGreaterThan(0.1); // 0.158 rad/s: a joint that should be locked turns
    expect(creep(`frictionloss="2" solimpfriction="${flat}"`)).toBeLessThan(2e-4); // 1.5e-4 rad/s
    expect(creep(`frictionloss="2" solimpfriction="${flat}" solreffriction="0.0002 1"`)).toBeLessThan(2e-5); // 1.5e-5 rad/s
  });

  it('while sticking the friction row carries exactly the applied torque (readable per row)', () => {
    const { data, step } = build(rotor(`frictionloss="2" solimpfriction="${flat}"`));
    data.qfrc_applied[0] = 1.5;
    step(200);
    expect(data.nefc).toBe(1);
    expect(value(data.efc_force)).toBeCloseTo(-1.5, 3);
  });

  it('fallback measured: rebuilding model + data takes about 0.6 ms (about 500 mj_step calls), so it is affordable if ever needed', () => {
    const xml = rotor('frictionloss="1"');
    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      const { model, data } = build(xml);
      data.delete();
      model.delete();
    }
    expect((performance.now() - start) / 50).toBeLessThan(25); // 0.64 ms on the reference machine; loose for a loaded CI
  });
});

describe('OQ-DRV-02: joint limit with solreflimit direct form (VC-DRV-20)', () => {
  const inertia = 0.01;
  const stiffness = 1000; // N m/rad
  const zeta = 0.2;
  const omegaN = Math.sqrt(stiffness / inertia);
  const damping = 2 * zeta * Math.sqrt(stiffness * inertia);
  // MuJoCo's direct form is an ACCELERATION law (scaled by the row's effective inertia): physical K [N m/rad] / J.
  const accelerationK = omegaN * omegaN;
  const accelerationB = damping / inertia;

  const limitXml = (j: number, solref: [number, number], solimp: string, dt: number): string =>
    `<mujoco>${option(dt)}<worldbody><body>${hinge('j', `limited="true" range="-10 0" solreflimit="${-solref[0]} ${-solref[1]}" solimplimit="${solimp}"`)}${inertial(j)}</body></worldbody></mujoco>`;

  /** Impact at 1 rad/s into the upper stop (range [-10, 0]); returns the exit speed ratio and the deepest penetration. */
  function impact(j: number, solref: [number, number], solimp: string, dt = 1e-5): { restitution: number; peak: number; exitTime: number } {
    const { data, step } = build(limitXml(j, solref, solimp, dt));
    data.qpos[0] = -1e-6;
    data.qvel[0] = 1;
    let peak = 0;
    let entry = 0;
    for (let i = 0; i < 20000; i++) {
      const before = value(data.qvel);
      step(1);
      const q = value(data.qpos);
      peak = Math.max(peak, q);
      if (entry === 0 && q > 0) entry = before;
      if (entry !== 0 && q <= 0) return { restitution: -value(data.qvel) / entry, peak, exitTime: data.time };
    }
    throw new Error('no rebound');
  }

  /** One-sided linear spring-damper (force cannot pull), fine explicit integration: the physical oracle of an end stop. */
  function oneSided(k: number, c: number, mass: number): { restitution: number; peak: number } {
    let x = 0;
    let v = 1;
    let peak = 0;
    const h = 1e-6;
    for (;;) {
      v -= (Math.max(0, k * x + c * v) / mass) * h;
      x += v * h;
      peak = Math.max(peak, x);
      if (x <= 0) return { restitution: -v, peak };
    }
  }

  const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as {
    endStop: { restitution: number; restitutionBilateral: number; peakPenetrationRad: number };
  };

  it('with a flat impedance the impact is a one-sided linear spring-damper (0.04 % restitution, 0.01 % peak)', () => {
    const measured = impact(inertia, [accelerationK, accelerationB], flat);
    const expected = oneSided(stiffness, damping, inertia);
    expect(measured.restitution).toBeCloseTo(expected.restitution, 3); // 0.5719 vs 0.5717
    expect(measured.peak / expected.peak).toBeCloseTo(1, 3); // 2.3914e-3 rad
    expect(measured.exitTime).toBeCloseTo(0.01011, 4);
  });

  it('the default limit impedance (0.9, 0.95) distorts the peak by 0.5 %: flat solimp is the rule', () => {
    const shaped = impact(inertia, [accelerationK, accelerationB], '0.9 0.95 0.001');
    const flatRun = impact(inertia, [accelerationK, accelerationB], flat);
    expect(Math.abs(shaped.peak / flatRun.peak - 1)).toBeGreaterThan(0.003);
    expect(Math.abs(shaped.restitution - flatRun.restitution)).toBeGreaterThan(1e-3);
  });

  it('stiffness and damping are mass-normalised: the same pair behaves the same on a 4x heavier body; force units are wrong by J', () => {
    const light = impact(inertia, [accelerationK, accelerationB], flat);
    const heavy = impact(4 * inertia, [accelerationK, accelerationB], flat);
    expect(heavy.restitution).toBeCloseTo(light.restitution, 6);
    expect(heavy.peak).toBeCloseTo(light.peak, 9);
    const asForce = impact(inertia, [stiffness, damping], flat); // N m/rad passed unscaled: omega_n is 10x too low
    expect(asForce.restitution).toBeGreaterThan(0.9); // 100x too soft and 100x too lightly damped: 0.94 instead of 0.57
    expect(asForce.peak).toBeGreaterThan(2.5 * light.peak);
  });

  it('the pack reference is the one-sided restitution (0.5717, regenerated in DRV-M1); the bilateral 0.5266 is 8.6 % away from a stop', () => {
    const measured = impact(inertia, [accelerationK, accelerationB], flat).restitution;
    expect(Math.abs(measured / reference.endStop.restitution - 1)).toBeLessThan(0.001);
    expect(Math.abs(measured / reference.endStop.restitutionBilateral - 1)).toBeGreaterThan(0.05);
    expect(reference.endStop.peakPenetrationRad).toBeCloseTo(oneSided(stiffness, damping, inertia).peak, 5);
  });

  it('timestep: restitution drifts +0.45 % at 1e-4 s and +6.8 % at 1e-3 s (omega_n dt 0.03 / 0.32): keep omega_n dt below 0.05', () => {
    const base = impact(inertia, [accelerationK, accelerationB], flat, 1e-5).restitution;
    expect(impact(inertia, [accelerationK, accelerationB], flat, 1e-4).restitution / base - 1).toBeLessThan(0.01);
    expect(impact(inertia, [accelerationK, accelerationB], flat, 1e-3).restitution / base - 1).toBeGreaterThan(0.05);
  });

  it('the limit row is readable: type joint-limit, efc_force in N m equals K x + B v of the stop', () => {
    const { data, step } = build(limitXml(inertia, [accelerationK, accelerationB], flat, 1e-5));
    data.qpos[0] = -1e-6;
    data.qvel[0] = 1;
    step(300); // 3 ms: inside the contact (peak at 4.4 ms)
    expect(data.nefc).toBe(1);
    expect(data.efc_type[0]).toBe(CNSTR.limitJoint);
    const expectedTorque = stiffness * value(data.qpos) + damping * value(data.qvel);
    expect(value(data.efc_force) / expectedTorque).toBeCloseTo(1, 2);
  });

  it('explicit alternative: the stop as an applied force (qfrc_applied) matches the same oracle at omega_n dt 0.03', () => {
    const { data, step } = build(`<mujoco>${option(1e-4)}<worldbody><body>${hinge('j')}${inertial(inertia)}</body></worldbody></mujoco>`);
    data.qpos[0] = -1e-6;
    data.qvel[0] = 1;
    let entry = 0;
    for (let i = 0; i < 2000; i++) {
      const q = value(data.qpos);
      const v = value(data.qvel);
      data.qfrc_applied[0] = q > 0 ? -Math.max(0, stiffness * q + damping * v) : 0;
      if (entry === 0 && q > 0) entry = v;
      step(1);
      if (entry !== 0 && value(data.qpos) <= 0) break;
    }
    expect(-value(data.qvel) / entry).toBeCloseTo(oneSided(stiffness, damping, inertia).restitution, 1);
  });
});

describe('fixed tendon limit as backlash', () => {
  const gap = 0.01;
  const stiffness = 1e6;
  const damping = Math.sqrt(stiffness);
  const xml = `<mujoco>${option(1e-4)}<worldbody><body>${hinge('a')}${inertial(0.01)}</body><body>${hinge('b')}${inertial(0.02)}</body></worldbody><tendon><fixed name="t" limited="true" range="${-gap / 2} ${gap / 2}" solreflimit="${-stiffness} ${-damping}" solimplimit="${flat}"><joint joint="a" coef="1"/><joint joint="b" coef="-1"/></fixed></tendon></mujoco>`;

  it('the driver crosses the free gap alone, then drags the load; the row is a tendon-limit row', () => {
    const { data, step } = build(xml);
    data.qfrc_applied[0] = 0.1;
    let firstContactStep = 0;
    let deepest = 0;
    for (let i = 1; i <= 3000; i++) {
      step(1);
      if (firstContactStep === 0 && Math.abs(value(data.qpos, 1)) > 1e-9) firstContactStep = i;
      deepest = Math.max(deepest, value(data.qpos) - value(data.qpos, 1) - gap / 2);
    }
    const freeFlight = Math.sqrt(gap / (0.1 / 0.01)); // theta = 1/2 alpha t^2 reaches gap/2
    expect(firstContactStep * 1e-4).toBeCloseTo(freeFlight, 3); // 0.0316 s
    expect(deepest).toBeLessThan(0.02 * gap); // 1.6e-4 rad
    expect(value(data.qpos) - value(data.qpos, 1)).toBeCloseTo(gap / 2, 4); // pressed against the far flank
    expect(value(data.qvel)).toBeCloseTo(value(data.qvel, 1), 3); // locked together afterwards
    expect(value(data.qvel)).toBeCloseTo(1.0, 2); // momentum + 0.1 N m on the pair: 1.0 rad/s at 0.3 s
    expect(data.efc_type[0]).toBe(CNSTR.limitTendon);
    expect(value(data.efc_force)).toBeGreaterThan(0);
    expect(value(data.ten_length)).toBeCloseTo(gap / 2, 4);
  });

  it('no row is active inside the gap (the load does not move while the flanks are apart)', () => {
    const { data, step } = build(xml);
    data.qfrc_applied[0] = 0.1;
    step(100); // 10 ms: theta_a = 5e-4 rad
    expect(data.nefc).toBe(0);
    expect(value(data.qpos, 1)).toBe(0);
  });
});

describe('hinge-slide equality (rack / lead-screw coupling)', () => {
  const ratio = 0.002 / (2 * Math.PI); // m/rad of a 2 mm lead
  const xml = (solref: string, solimp: string): string =>
    `<mujoco>${option(1e-4)}<worldbody><body>${hinge('a')}${inertial(0.001)}</body><body><joint name="b" type="slide" axis="1 0 0"/><inertial pos="0 0 0" mass="2" diaginertia="1 1 1"/></body></worldbody><equality><joint joint1="b" joint2="a" polycoef="0 ${ratio} 0 0 0" solref="${solref}" solimp="${solimp}"/></equality></mujoco>`;

  it('a tight solref and flat impedance enforce q_b = ratio * q_a to 1e-6 and give the reflected inertia J + m ratio^2', () => {
    const { data, step } = build(xml('0.0004 1', flat));
    data.qfrc_applied[0] = 0.0005;
    step(5000);
    const alpha = 0.0005 / (0.001 + 2 * ratio * ratio);
    expect(value(data.qpos)).toBeCloseTo(0.5 * alpha * 0.25, 4);
    const residual = value(data.qpos, 1) - ratio * value(data.qpos);
    expect(Math.abs(residual / (ratio * value(data.qpos)))).toBeLessThan(1e-6);
    expect(data.nefc).toBe(1);
    expect(data.efc_type[0]).toBe(CNSTR.equality);
    expect(value(data.efc_force)).toBeCloseTo(2 * ratio * alpha, 5); // the axial force of the nut m a, readable per row
  });

  it('the default equality solref is soft: the coupling lags by 73 % of the travel under this load', () => {
    const { data, step } = build(xml('0.02 1', '0.9 0.95 0.001'));
    data.qfrc_applied[0] = 0.0005;
    step(5000);
    const relative = (value(data.qpos, 1) - ratio * value(data.qpos)) / (ratio * value(data.qpos));
    expect(Math.abs(relative)).toBeGreaterThan(0.1);
  });
});

describe('armature', () => {
  const xml = `<mujoco>${option(1e-4)}<worldbody><body>${hinge('j', 'armature="0.02"')}${inertial(0.01)}</body></worldbody></mujoco>`;

  it('adds to the joint inertia: omega = T t / (J + armature)', () => {
    const { data, step } = build(xml);
    data.qfrc_applied[0] = 1;
    step(1000);
    expect(value(data.qvel)).toBeCloseTo(0.1 / 0.03, 9);
  });

  it('a dof_armature write needs mj_setConst to take effect; the bare write is silently ignored', () => {
    const bare = build(xml);
    bare.model.dof_armature[0] = 0.04;
    bare.data.qfrc_applied[0] = 1;
    bare.step(1000);
    expect(value(bare.data.qvel)).toBeCloseTo(0.1 / 0.03, 9); // still 0.02

    const refreshed = build(xml);
    refreshed.model.dof_armature[0] = 0.04;
    mj.mj_setConst(refreshed.model, refreshed.data);
    refreshed.data.qfrc_applied[0] = 1;
    refreshed.step(1000);
    expect(value(refreshed.data.qvel)).toBeCloseTo(0.1 / 0.05, 9);
  });
});

describe('D-DRV-01: core DC motor law vs MuJoCo dcmotor on the exact 148877 step (VC-DRV-04)', () => {
  interface Sample {
    readonly tS: number;
    readonly currentA: number;
    readonly speedRadS: number;
  }
  const reference = JSON.parse(readFileSync(referencePath, 'utf8')) as { dcStep: { samples: Sample[]; currentPeak: { currentA: number } } };
  const [resistance, inductance, torqueConstant, rotorInertia, voltage] = [1.13, 0.00033, 0.0603, 1.37e-5, 48];
  const rotor = (actuator: string, dt: number): string =>
    `<mujoco>${option(dt)}<worldbody><body>${hinge('j')}${inertial(rotorInertia)}</body></worldbody>${actuator}</mujoco>`;
  const nativeActuator = `<actuator><dcmotor name="m" joint="j" motorconst="${torqueConstant}" resistance="${resistance}" inductance="${inductance}"/></actuator>`;

  interface Errors {
    readonly maxSpeed: number;
    readonly maxCurrent: number;
    readonly peak: number;
  }
  /** Relative errors against the exact solution at the reference samples that fall on a step; `advance` takes one step and returns the current. */
  function compare(dt: number, actuator: string, advance: (data: RawData, step: () => void) => number): Errors {
    const { model, data } = build(rotor(actuator, dt));
    const sampleAt = new Map(
      reference.dcStep.samples
        .filter((s) => Math.abs(s.tS / dt - Math.round(s.tS / dt)) < 1e-6)
        .map((s) => [Math.round(s.tS / dt), s] as const),
    );
    let [maxSpeed, maxCurrent, peak] = [0, 0, 0];
    for (let i = 1; i <= Math.round(0.03 / dt); i++) {
      const current = advance(data, () => mj.mj_step(model, data));
      peak = Math.max(peak, current);
      const sample = sampleAt.get(i);
      if (sample === undefined) continue;
      maxSpeed = Math.max(maxSpeed, Math.abs(value(data.qvel) / sample.speedRadS - 1));
      maxCurrent = Math.max(maxCurrent, Math.abs(current / sample.currentA - 1));
    }
    return { maxSpeed, maxCurrent, peak: Math.abs(peak / reference.dcStep.currentPeak.currentA - 1) };
  }

  const nativeRun = (dt: number): Errors =>
    compare(dt, nativeActuator, (data, step) => {
      data.ctrl[0] = voltage;
      step();
      return value(data.act);
    });

  /** The core law of spec 5.1: exact exponential in i with omega frozen at the step midpoint; the torque is kt times the mean current. */
  const coreRun = (dt: number): Errors => {
    let current = 0;
    const rate = resistance / inductance;
    const decay = Math.exp(-rate * dt);
    return compare(dt, '', (data, step) => {
      const midpoint = value(data.qvel) + (0.5 * dt * torqueConstant * current) / rotorInertia;
      const steady = (voltage - torqueConstant * midpoint) / resistance;
      const mean = steady + ((current - steady) * (1 - decay)) / (rate * dt);
      data.qfrc_applied[0] = torqueConstant * mean;
      step();
      current = steady + (current - steady) * decay;
      return current;
    });
  };

  it('core law: every sample within 0.005 % at dt 1e-5, 0.01 % at 2.5e-5; peak current 0.001 %', () => {
    const fine = coreRun(1e-5);
    expect(fine.maxSpeed).toBeLessThan(5e-5);
    expect(fine.maxCurrent).toBeLessThan(5e-5);
    expect(fine.peak).toBeLessThan(1e-4);
    const coarse = coreRun(2.5e-5);
    expect(coarse.maxSpeed).toBeLessThan(1e-3);
    expect(coarse.maxCurrent).toBeLessThan(2e-3);
  });

  it('core law at dt 1e-4 (a third of the electrical time constant) still meets the 0.5 % acceptance (AC-3)', () => {
    const errors = coreRun(1e-4);
    expect(errors.maxSpeed).toBeLessThan(0.005);
    expect(errors.maxCurrent).toBeLessThan(0.005);
    expect(errors.peak).toBeLessThan(0.005);
  });

  it('native dcmotor is first order: speed 1.5 % off at 0.5 ms for dt 1e-5, current 5 % off at dt 1e-4: it fails the 0.5 % acceptance', () => {
    const fine = nativeRun(1e-5);
    expect(fine.maxSpeed).toBeGreaterThan(0.005);
    expect(fine.maxSpeed).toBeLessThan(0.02);
    expect(fine.maxCurrent).toBeLessThan(0.005);
    const coarse = nativeRun(1e-4);
    expect(coarse.maxCurrent).toBeGreaterThan(0.03);
    expect(coarse.maxSpeed).toBeGreaterThan(0.1);
  });
});
