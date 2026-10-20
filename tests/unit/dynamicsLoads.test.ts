import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { SimulationData } from '@core/dynamics/simulationReport';
import { bodyCentres, dynamicsLoads, formatQuantity } from '@ui/dynamicsLoads';

function run(doc: CadDocument, name: string, params: Record<string, unknown>): { doc: CadDocument; id: string } {
  const result = execute(doc, name, params);
  expect(result.error, result.summary).toBeUndefined();
  return { doc: result.document, id: result.affected[0] ?? '' };
}

/** A 200 mm steel disc on a horizontal shaft (y axis) through the origin. */
function rotor(): { doc: CadDocument; bodyId: string; jointId: string } {
  const disc = run(createEmptyDocument(), 'add_cylinder', { radius: 100, height: 20, axis: [0, 1, 0] });
  const body = run(disc.doc, 'add_rigid_body', { entityIds: [disc.id], name: 'flywheel' });
  const joint = run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [0, 0, 0], axis: [0, 1, 0], damping: 0.02 });
  return { doc: joint.doc, bodyId: body.id, jointId: joint.id };
}

describe('dynamicsLoads', () => {
  it('is empty without a dynamics model', () => {
    expect(dynamicsLoads(createEmptyDocument(), null, {})).toEqual([]);
  });

  it("lists each body's weight at its centre of mass, pointing along gravity", () => {
    const { doc, bodyId } = rotor();
    const centres = bodyCentres(doc);
    const weight = dynamicsLoads(doc, null, centres).find((item) => item.id === `weight:${bodyId}`);
    // steel 7850 kg/m³ × π·0.1²·0.02 m³ = 4.932 kg → 48.38 N
    expect(weight?.magnitude).toBeCloseTo(4.932 * 9.81, 1);
    expect(weight?.value).toBe('W 48.4 N');
    expect(weight?.detail).toMatch(/^4\.93 kg · 7,850 kg\/m³/);
    expect(weight?.direction).toEqual([0, 0, -1]);
    expect(weight?.origin).toEqual(centres[bodyId]);
  });

  it('shows the joint axis with its damping, friction and parents', () => {
    const { doc, jointId } = rotor();
    const joint = dynamicsLoads(doc, null, bodyCentres(doc)).find((item) => item.id === jointId);
    expect(joint).toMatchObject({ layer: 'joints', shape: 'axis', title: 'flywheel ⟳ ground', direction: [0, 1, 0], magnitude: null });
    expect(joint?.detail).toBe('revolute · damping 0.02 N·m·s/rad · friction 0 N·m');
  });

  it('sizes a torque-curve motor by its throttled peak and a governed propeller by its thrust at the governed speed', () => {
    const { doc: base, jointId } = rotor();
    let doc = run(base, 'add_motor', {
      joint: jointId,
      kind: 'torque_curve',
      curve: [
        [1000, 400],
        [2700, 475],
      ],
      throttle: 0.5,
    }).doc;
    doc = run(doc, 'add_motor', { joint: jointId, kind: 'speed', rpm: 2400, maxTorque: 600 }).doc;
    doc = run(doc, 'add_propeller', {
      joint: jointId,
      diameter: 1,
      thrustCoefficient: 0.1,
      powerCoefficient: 0.05,
      thrustDirection: [0, 1, 0],
    }).doc;
    const loads = dynamicsLoads(doc, null, bodyCentres(doc));
    const [curve, governor] = loads.filter((item) => item.layer === 'drives');
    expect(curve).toMatchObject({ value: '≤ 238 N·m', magnitude: 237.5 });
    expect(curve?.detail).toBe('torque curve 1,000–2,700 rpm, peak 475 N·m @ 2,700 rpm · throttle 50 %');
    expect(governor).toMatchObject({ value: '2,400 rpm', magnitude: 600 });
    // T = Ct·ρ·n²·D⁴ = 0.1 × 1.225 × 40² × 1 = 196 N
    const thrust = loads.find((item) => item.layer === 'thrust');
    expect(thrust?.magnitude).toBeCloseTo(196, 6);
    expect(thrust?.value).toBe('T 196 N');
    expect(thrust?.direction).toEqual([0, 1, 0]);
  });

  it('reads thrust and motor torque at the playback time, and the body where the replay has moved it', () => {
    const { doc: base, jointId, bodyId } = rotor();
    let doc = run(base, 'add_motor', { joint: jointId, kind: 'torque_curve', torque: 20, id: 'engine' }).doc;
    doc = run(doc, 'add_propeller', { joint: jointId, diameter: 1, thrustCoefficient: 0.1, powerCoefficient: 0.05, id: 'prop' }).doc;
    const result = {
      joints: {},
      gears: {},
      series: {
        times: [0, 1, 2],
        jointVelocity: { [jointId]: [0, 100, 200] },
        jointPosition: {},
        motorTorque: { engine: [20, 18, 15] },
        propellerThrust: { prop: [0, 50, 120] },
        propellerPower: {},
      },
      poses: {
        times: [0, 1, 2],
        bodies: {
          [bodyId]: {
            position: [
              [0, 0, 0],
              [0, 5, 0],
              [0, 10, 0],
            ],
            orientation: [],
          },
        },
      },
    } as unknown as SimulationData;
    const loads = dynamicsLoads(doc, { result, time: 1.5 }, bodyCentres(doc));
    expect(loads.find((item) => item.id === 'engine')).toMatchObject({ value: '18 N·m', magnitude: 18 });
    expect(loads.find((item) => item.id === 'prop')).toMatchObject({ value: 'T 50 N', magnitude: 50, origin: [0, 5, 0] });
    expect(loads.find((item) => item.id === jointId)?.value).toBe('955 rpm');
    expect(loads.find((item) => item.id === `weight:${bodyId}`)?.origin).toEqual([0, 5, 0]);
  });

  it('says a propeller without a governor has its thrust only after a run', () => {
    const { doc: base, jointId } = rotor();
    const doc = run(base, 'add_propeller', { joint: jointId, diameter: 1.88, thrustCoefficient: 0.09, powerCoefficient: 0.04 }).doc;
    const thrust = dynamicsLoads(doc, null, bodyCentres(doc)).find((item) => item.layer === 'thrust');
    expect(thrust).toMatchObject({ value: 'T after a run', magnitude: null });
  });

  it('links coupled joints with their ratio', () => {
    const { doc: base, jointId } = rotor();
    const gearDisc = run(base, 'add_cylinder', { radius: 50, height: 20, axis: [0, 1, 0], position: [300, 0, 0] });
    const body = run(gearDisc.doc, 'add_rigid_body', { entityIds: [gearDisc.id], name: 'pinion' });
    const joint = run(body.doc, 'add_body_joint', { kind: 'revolute', child: body.id, anchor: [300, 0, 0], axis: [0, 1, 0] });
    const doc = run(joint.doc, 'add_gear_coupling', { driver: jointId, driven: joint.id, ratio: -2 }).doc;
    const link = dynamicsLoads(doc, null, bodyCentres(doc)).find((item) => item.shape === 'link');
    expect(link).toMatchObject({ value: 'ratio -2', origin: [0, 0, 0], end: [300, 0, 0] });
  });

  it('formats large and tiny quantities in scientific notation', () => {
    expect(formatQuantity(123456)).toBe('1.23e+5');
    expect(formatQuantity(0.001)).toBe('1.00e-3');
    expect(formatQuantity(0)).toBe('0');
  });

  it('draws the joint reaction at the playback time on the anchor carried by the child body (reactions layer)', () => {
    const { doc, bodyId, jointId } = rotor();
    const result = {
      duration: 1,
      joints: {},
      motors: {},
      propellers: {},
      gears: {},
      poses: {
        times: [0, 1],
        bodies: {
          [bodyId]: {
            position: [
              [0, 0, 0],
              [0, 0, 10],
            ],
            orientation: [
              [1, 0, 0, 0],
              [1, 0, 0, 0],
            ],
          },
        },
      },
      reactions: {
        joints: { [jointId]: { forceN: { value: 50, timeS: 1, angleDeg: null } } },
        series: {
          times: [0, 1],
          joints: {
            [jointId]: {
              force: [
                [0, 0, 10],
                [0, 0, 50],
              ],
              moment: [
                [0, 0, 0],
                [0, 0, 0],
              ],
            },
          },
        },
      },
    } as unknown as SimulationData;
    const reaction = dynamicsLoads(doc, { result, time: 1 }, bodyCentres(doc)).find((item) => item.layer === 'reactions');
    expect(reaction).toMatchObject({ id: `reaction:${jointId}`, shape: 'force', magnitude: 50, direction: [0, 0, 1], origin: [0, 0, 10] });
    expect(reaction?.value).toBe('R 50 N');
    expect(dynamicsLoads(doc, null, bodyCentres(doc)).some((item) => item.layer === 'reactions')).toBe(false);
  });
});
