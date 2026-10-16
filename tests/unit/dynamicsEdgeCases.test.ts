/**
 * Edge cases of the PHY-21 dynamics layer without a physics engine: topology of odd graphs, consistent start speeds, engine geometry
 * refusals, cylinder preparation errors, reaction conventions on synthetic traces.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createDynamicsModel, type CylinderPressure, type DynamicsModel } from '@core/model/dynamics';
import type { CadDocument } from '@core/model/types';
import { consistentSpeeds, analyseMobility } from '@core/dynamics/mobility';
import { buildTopology, isRefusal, type Topology } from '@core/dynamics/topology';
import { engineLayout } from '@core/dynamics/engineGeometry';
import { prepareCylinders } from '@core/dynamics/cylinderLoads';
import { buildSimulationModel } from '@core/dynamics/simulationModel';
import { reactionsData, residualTier } from '@core/dynamics/reactions';
import type { SimulationTrace } from '@core/dynamics/physicsEngine';
import { sliderCrank, travelRate } from './sliderCrankFixture';

const joint = (id: string, parent: string, child: string, extra: Record<string, unknown> = {}): DynamicsModel['joints'][string] => ({
  id,
  kind: 'revolute',
  parent,
  child,
  anchor: [0, 0, 0],
  axis: [0, 0, 1],
  damping: 0,
  friction: 0,
  initialVelocity: 0,
  ...extra,
});

const body = (id: string, fixed = false): DynamicsModel['bodies'][string] => ({ id, entityIds: ['x'], fixed });

const model = (bodies: string[], joints: DynamicsModel['joints'], fixed: string[] = []): DynamicsModel => ({
  ...createDynamicsModel(),
  bodies: Object.fromEntries(bodies.map((id) => [id, body(id, fixed.includes(id))])),
  joints,
});

const topologyOf = (dynamics: DynamicsModel): Topology => {
  const result = buildTopology(dynamics);
  if (isRefusal(result)) throw new Error(result.error);
  return result;
};

describe('topology of unusual graphs', () => {
  it('refuses a joint that references a missing body (FPR_JOINT_DANGLING)', () => {
    const result = buildTopology(model(['a'], { j: joint('j', 'a', 'ghost') }));
    expect(result).toMatchObject({ code: 'FPR_JOINT_DANGLING', ids: ['j', 'ghost'] });
  });

  it('ignores a joint whose child is welded to the ground', () => {
    const topology = topologyOf(model(['f', 'a'], { weld: joint('weld', 'ground', 'f'), hinge: joint('hinge', 'f', 'a') }, ['f']));
    expect(topology.tree.map((entry) => entry.joint.id)).toEqual(['hinge']);
    expect(topology.loops).toEqual([]);
    expect(topology.tree[0]).toMatchObject({ parent: 'f', child: 'a', flipped: false });
  });

  it('roots a chain that never reaches the ground at its parent-most body, in parent-first order', () => {
    const topology = topologyOf(model(['c', 'b', 'a'], { j1: joint('j1', 'b', 'c'), j2: joint('j2', 'a', 'b') }));
    expect(topology.bodyOrder).toEqual(['a', 'b', 'c']);
    expect(topology.tree.map((entry) => entry.parent)).toEqual(['b', 'a']);
    expect(topology.flipped).toEqual([]);
    expect(topology.jointOfBody.has('a')).toBe(false);
  });

  it('a free loop (two bodies joined twice, no ground) still has a tree and one closure', () => {
    const topology = topologyOf(model(['a', 'b'], { j1: joint('j1', 'a', 'b'), j2: joint('j2', 'b', 'a') }));
    expect(topology.tree).toHaveLength(1);
    expect(topology.loops.map((loop) => loop.id)).toEqual(['j2']);
  });

  it('a joint declared child-first is walked against its sense and flagged', () => {
    const topology = topologyOf(model(['a', 'b'], { g: joint('g', 'ground', 'b'), j: joint('j', 'a', 'b'), h: joint('h', 'ground', 'a') }));
    // g and j are tree joints; h, declared last, closes the loop
    expect(topology.loops.map((loop) => loop.id)).toEqual(['h']);
    const reversed = topologyOf(model(['a', 'b'], { g: joint('g', 'ground', 'b'), j: joint('j', 'a', 'b') }));
    expect(reversed.flipped).toEqual(['j']);
    expect(reversed.tree.find((entry) => entry.joint.id === 'j')).toMatchObject({ parent: 'b', child: 'a', flipped: true });
  });
});

describe('start speeds consistent with the loops', () => {
  it('the piston and rod follow the prescribed crank speed: piston speed = -dx/dtheta * omega', () => {
    const { doc, r, l } = sliderCrank({ startDeg: 60 });
    const dynamics = doc.dynamics!;
    const topology = topologyOf(dynamics);
    const speeds = consistentSpeeds(topology, { crank_j: 100 }, 0.001);
    expect(speeds['crank_j']).toBe(100);
    expect(speeds['slide_j']).toBeCloseTo(-travelRate(r, l, (60 * Math.PI) / 180) * 100, 6);
    // the rod turns relative to the crank so that the pin stays on the rod: its absolute rate is small and finite
    expect(Math.abs(speeds['rod_j'] ?? Infinity)).toBeLessThan(200);
    expect(analyseMobility(dynamics, topology, 0.001).loopGapsM['wrist_j']).toBeCloseTo(0, 12);
  });

  it('returns the prescribed speeds when nothing or everything is prescribed, and for loop-free trees', () => {
    const { doc } = sliderCrank();
    const topology = topologyOf(doc.dynamics!);
    expect(consistentSpeeds(topology, {}, 0.001)).toEqual({ crank_j: 0, rod_j: 0, slide_j: 0 });
    expect(consistentSpeeds(topology, { crank_j: 1, rod_j: 2, slide_j: 3 }, 0.001)).toEqual({ crank_j: 1, rod_j: 2, slide_j: 3 });
    const free = topologyOf(model(['a'], { j: joint('j', 'ground', 'a') }));
    expect(consistentSpeeds(free, { j: 5 }, 0.001)).toEqual({ j: 5 });
  });

  it('mobility handles a revolute loop about the X axis and a model without tree joints', () => {
    const axisX = model(['a', 'b'], {
      p: joint('p', 'ground', 'a', { axis: [1, 0, 0] }),
      q: joint('q', 'a', 'b', { axis: [1, 0, 0], anchor: [0, 1, 0] }),
      r: joint('r', 'ground', 'b', { axis: [1, 0, 0], anchor: [0, 1, 0] }),
    });
    const mobility = analyseMobility(axisX, topologyOf(axisX), 1);
    expect(mobility.gruebler).toBe(12 - 15);
    expect(mobility.treeCoordinates).toBe(2);
    const none = model(['a'], {});
    expect(analyseMobility(none, topologyOf(none), 1)).toMatchObject({ treeCoordinates: 0, rank: 0, dof: 0 });
  });
});

describe('engine geometry refusals', () => {
  const cylinder = (patch: Partial<CylinderPressure> = {}): CylinderPressure => ({
    id: 'c',
    piston: 'slide_j',
    crank: 'crank_j',
    boreMm: 84,
    compressionRatio: 10,
    cycle: 'four_stroke',
    firingOffsetDeg: 0,
    tdcCrankAngleRad: null,
    ambientPressurePa: 101325,
    model: {
      kind: 'table',
      points: [
        [0, 0],
        [720, 0],
      ],
    },
    ...patch,
  });
  const layoutOf = (dynamics: DynamicsModel): ReturnType<typeof engineLayout> =>
    engineLayout(dynamics, topologyOf(dynamics), cylinder(), 0.001);
  const edited = (id: string, patch: Record<string, unknown>): DynamicsModel => {
    const dynamics = sliderCrank().doc.dynamics!;
    return { ...dynamics, joints: { ...dynamics.joints, [id]: { ...dynamics.joints[id]!, ...patch } } };
  };

  it('a piston on the negative side of the crank axis flips the head direction', () => {
    const layout = layoutOf(edited('slide_j', { axis: [-1, 0, 0] }));
    if ('error' in layout) throw new Error(layout.error);
    expect(layout.headSign).toBe(-1);
    expect(layout.headDirection[0]).toBe(1);
  });

  it('refuses a cylinder axis that is not perpendicular to the crank axis, a crank radius of zero and a short rod', () => {
    expect(layoutOf(edited('slide_j', { axis: [1, 0, 1] }))).toMatchObject({ error: expect.stringMatching(/perpendicular/) });
    expect(layoutOf(edited('rod_j', { anchor: [0, 0, 0] }))).toMatchObject({ error: expect.stringMatching(/crank radius 0/) });
    expect(layoutOf(edited('rod_j', { anchor: [140, 0, 0] }))).toMatchObject({ error: expect.stringMatching(/not longer than/) });
  });

  it('prepareCylinders reports a bad model, bad geometry and a refused curve, and a curve lookup that fails later throws', () => {
    const dynamics = sliderCrank({ rMm: 30.5, lMm: 130 }).doc.dynamics!;
    const topology = topologyOf(dynamics);
    const prepare = (patch: Partial<CylinderPressure>, base: DynamicsModel = dynamics): ReturnType<typeof prepareCylinders> =>
      prepareCylinders({ ...base, cylinders: { c: cylinder(patch) } }, topology, 0.001);
    expect(prepare({ firingOffsetDeg: 90 })).toMatchObject({ error: expect.stringMatching(/cylinder 'c': firingOffsetDeg/) });
    expect(prepare({ piston: 'crank_j' })).toMatchObject({ error: expect.stringMatching(/cylinder 'c': piston/) });
    expect(
      prepare({
        model: {
          kind: 'table',
          points: [
            [0, 0],
            [100, 0],
          ],
        },
      }),
    ).toMatchObject({ code: 'FPR_PRESSURE_TABLE_GAP' });
    const single: CylinderPressure['model'] = {
      kind: 'single_zone',
      burn: { ca50Deg: 9, durationDeg: 35, a: 5, m: 2, rpmExponent: 0.5 },
      woschni: { c1: 3.26, c2Closed: 2.28, c2Exchange: 6.18, c3: 0.00324, tempExponent: -0.53, wallTempK: 450 },
      intakePressurePa: 95000,
      intakeTempK: 330,
      heat: { kind: 'per_cycle_J', value: 300 },
    };
    const runtimes = prepare({ model: single });
    if ('error' in runtimes) throw new Error(runtimes.error);
    expect(runtimes[0]?.curveAt(1000).heatJ).toBe(300);
    expect(runtimes[0]?.curveAt(1010)).toBe(runtimes[0]?.curveAt(1000));
    // at an extreme speed the burn scales out of the stroke: the lookup refuses
    expect(() => runtimes[0]?.curveAt(9e9)).toThrow(/cylinder 'c'/);
  });

  it('buildSimulationModel passes a cylinder refusal on with its code and clamps sensible speeds', () => {
    const { doc } = sliderCrank();
    const withBadTable: CadDocument = {
      ...doc,
      dynamics: {
        ...doc.dynamics!,
        cylinders: {
          c: cylinder({
            model: {
              kind: 'table',
              points: [
                [0, 0],
                [100, 0],
              ],
            },
          }),
        },
      },
    };
    expect(buildSimulationModel(withBadTable, 0.001)).toMatchObject({ code: 'FPR_PRESSURE_TABLE_GAP' });
  });
});

describe('reaction conventions on synthetic traces', () => {
  const { doc } = sliderCrank();
  const topology = topologyOf(doc.dynamics!);
  const times = [0, 1, 2];
  const flat = (v: [number, number, number]): [number, number, number][] => [v, v, v];
  const trace = (extra: Partial<SimulationTrace>): SimulationTrace => ({
    times,
    jointPosition: {},
    jointVelocity: {},
    bodyPosition: {},
    bodyOrientation: {},
    servoForce: {},
    ...extra,
  });

  it('an engine without reaction output gives none; with it peaks carry time and angle, series on request', () => {
    expect(reactionsData({ topology, trace: trace({}), mode: 'peaks', angleDeg: null, tier: 'pass' })).toBeNull();
    const full = trace({
      jointReaction: {
        crank_j: {
          force: [
            [0, 0, 1],
            [0, 0, 5],
            [0, 0, 2],
          ],
          moment: flat([0, 0, 0]),
        },
        rod_j: { force: flat([1, 0, 0]), moment: flat([0, 1, 0]) },
        slide_j: { force: flat([0, 3, 0]), moment: flat([0, 0, 0]) },
      },
      loopForce: {
        wrist_j: [
          [0, 0, 0],
          [3, 4, 0],
          [0, 0, 0],
        ],
      },
    });
    const peaks = reactionsData({ topology, trace: full, mode: 'peaks', angleDeg: [10, 20, 30], tier: 'warn' });
    expect(peaks?.quality).toBe('approximate');
    expect(peaks?.joints['crank_j']?.forceN).toEqual({ value: 5, timeS: 1, angleDeg: 20 });
    expect(peaks?.loops['wrist_j']?.forceN.value).toBe(5);
    expect(peaks?.series).toBeUndefined();
    const series = reactionsData({ topology, trace: full, mode: 'series', angleDeg: null, tier: 'fail' });
    expect(series?.quality).toBe('unreliable');
    expect(series?.series?.loops['wrist_j']).toHaveLength(3);
    expect(series?.joints['crank_j']?.forceN.angleDeg).toBeNull();
  });

  it('reverses the force on a flipped tree joint and skips joints the engine did not report', () => {
    const flipped = topologyOf(sliderCrank({ wrist: 'revolute', order: ['slide_j', 'wrist_j', 'crank_j', 'rod_j'] }).doc.dynamics!);
    const reversed = trace({ jointReaction: { wrist_j: { force: flat([0, 7, 0]), moment: flat([0, 0, 2]) } } });
    const data = reactionsData({ topology: flipped, trace: reversed, mode: 'series', angleDeg: null, tier: 'pass' });
    expect(data?.series?.joints['wrist_j']?.force[0]).toEqual([-0, -7, -0]);
    expect(data?.series?.joints['wrist_j']?.moment[0]).toEqual([-0, -0, -2]);
    expect(Object.keys(data?.joints ?? {})).toEqual(['wrist_j']);
    expect(data?.loops).toEqual({});
  });

  it('residual tiers: pass <= pass limit < warn <= fail limit < fail', () => {
    expect(['0.5', '1', '5', '10', '20'].map((micro) => residualTier(Number(micro) * 1e-6, 1e-6, 1e-5))).toEqual([
      'pass',
      'pass',
      'warn',
      'warn',
      'fail',
    ]);
  });
});

describe('cylinder run edge cases', () => {
  it('delete_dynamics_item for an unknown id fails cleanly and inspect lists cylinders', () => {
    const { doc } = sliderCrank();
    expect(execute(doc, 'delete_dynamics_item', { id: 'nothing' }).summary).toMatch(/no dynamics record/);
    const data = execute(doc, 'inspect_dynamics', {}).data as { cylinders: Record<string, unknown> };
    expect(data.cylinders).toEqual({});
  });
});
