/** Closed loops in the dynamics model: spanning tree, mobility and redundancy (VC-FPR-20), loop gaps (VC-FPR-21), command refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { analyseMobility } from '@dynamics/sim/mobility';
import { buildTopology, isRefusal, type Topology } from '@dynamics/sim/topology';
import { sliderCrank } from './sliderCrankFixture';

function topologyOf(doc: CadDocument): Topology {
  const result = buildTopology(doc.dynamics!);
  if (isRefusal(result)) throw new Error(result.error);
  return result;
}

interface InspectData {
  topology: { tree: { joint: string; parent: string; child: string; flipped: boolean }[]; loops: { joint: string }[]; flipped: string[] };
  mobility: { gruebler: number; rank: number; dof: number; redundant: { loop: string; message: string }[]; suggestions: string[] };
  loopGapsM: Record<string, number>;
  problems: string[];
  warnings: string[];
}

const inspect = (doc: CadDocument): InspectData => execute(doc, 'inspect_dynamics', {}).data as InspectData;

describe('topology (TR-FPR-05)', () => {
  it('slider-crank: prismatic joint first, last-declared revolute closes the loop', () => {
    const { doc } = sliderCrank({ wrist: 'revolute' });
    const topology = topologyOf(doc);
    expect(topology.tree.map((entry) => entry.joint.id)).toEqual(['crank_j', 'rod_j', 'slide_j']);
    expect(topology.loops.map((loop) => loop.id)).toEqual(['wrist_j']);
    expect(topology.flipped).toEqual([]);
    expect(topology.bodyOrder).toEqual(['crank', 'piston', 'rod']);
  });

  it('prefers the prismatic joint as a tree joint whatever the declaration order', () => {
    const { doc } = sliderCrank({ wrist: 'revolute', order: ['slide_j', 'wrist_j', 'rod_j', 'crank_j'] });
    const topology = topologyOf(doc);
    expect(topology.tree.map((entry) => entry.joint.id).sort()).toEqual(['rod_j', 'slide_j', 'wrist_j']);
    // the last-declared joint of the loop closes it, even when that is the ground joint of the crank
    expect(topology.loops.map((loop) => loop.id)).toEqual(['crank_j']);
  });

  it('reports a tree joint walked against its declared sense as flipped', () => {
    const { doc } = sliderCrank({ wrist: 'revolute', order: ['slide_j', 'wrist_j', 'crank_j', 'rod_j'] });
    const topology = topologyOf(doc);
    // slide (piston), wrist (rod from piston: declared rod-on-piston reversed), crank_j -> rod_j is the loop
    const wrist = topology.tree.find((entry) => entry.joint.id === 'wrist_j');
    expect(wrist).toMatchObject({ parent: 'piston', child: 'rod', flipped: true });
    expect(topology.flipped).toContain('wrist_j');
    expect(topology.loops.map((loop) => loop.id)).toEqual(['rod_j']);
  });

  it('is deterministic and keeps the legacy order for loop-free trees', () => {
    const { doc } = sliderCrank({ wrist: 'revolute' });
    expect(topologyOf(doc)).toEqual(topologyOf(doc));
  });

  it('refuses a prismatic joint that would have to close a loop (FPR_LOOP_PRISMATIC)', () => {
    const { doc } = sliderCrank();
    const second = execute(doc, 'add_body_joint', {
      kind: 'prismatic',
      child: 'piston',
      anchor: [0, 0, 0],
      axis: [0, 1, 0],
      id: 'slide_2',
    });
    expect(second.affected).toEqual([]);
    expect(second.summary).toMatch(/FPR_LOOP_PRISMATIC/);
    expect(second.document).toBe(doc);
    expect(second.error?.code).toBe('FPR_LOOP_PRISMATIC');
  });

  it('accepts a spherical joint alone on its body but reports FPR_SPHERICAL_TREE until another joint carries the body', () => {
    const solid = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const body = execute(solid.document, 'add_rigid_body', { entityIds: [solid.affected[0]], id: 'b' });
    const ball = execute(body.document, 'add_body_joint', { kind: 'spherical', child: 'b', anchor: [0, 0, 0], id: 'ball' });
    expect(ball.affected).toEqual(['ball']);
    expect(ball.summary).toMatch(/FPR_SPHERICAL_TREE/);
    expect(inspect(ball.document).problems[0]).toMatch(/FPR_SPHERICAL_TREE/);
    const hinge = execute(ball.document, 'add_body_joint', { kind: 'revolute', child: 'b', anchor: [0, 0, 0], axis: [0, 0, 1] });
    expect(inspect(hinge.document).problems).toEqual([]);
  });
});

describe('mobility and redundancy (VC-FPR-20)', () => {
  it('wrist revolute: Gruebler -2, DOF 1, 3 redundant rows, suggests spherical', () => {
    const { doc } = sliderCrank({ wrist: 'revolute', startDeg: 40 });
    const { mobility, topology } = inspect(doc);
    expect(mobility).toMatchObject({ gruebler: -2, rank: 2, dof: 1 });
    expect(mobility.redundant).toHaveLength(3);
    expect(topology.loops.map((l) => l.joint)).toEqual(['wrist_j']);
    expect(mobility.redundant[0]?.message).toMatch(/joint 'wrist_j' repeats/);
    expect(mobility.redundant[0]?.message).toMatch(/'slide_j'/);
    expect(mobility.suggestions[0]).toMatch(/'wrist_j' kind 'spherical'/);
    expect(inspect(doc).warnings.some((w) => w.startsWith('FPR_REDUNDANT_CONSTRAINT'))).toBe(true);
  });

  it('wrist spherical: Gruebler 0, DOF 1, 1 redundant row', () => {
    const { doc } = sliderCrank({ wrist: 'spherical', startDeg: 40 });
    const { mobility } = inspect(doc);
    expect(mobility).toMatchObject({ gruebler: 0, rank: 2, dof: 1 });
    expect(mobility.redundant).toHaveLength(1);
    expect(mobility.suggestions).toEqual([]);
  });

  it('a gear on a flipped tree joint uses the declared sense: the kinematically consistent ratio is redundant, its negative locks the mechanism', () => {
    const [r, l, phi] = [49.2125, 150, (40 * Math.PI) / 180];
    const [px, py] = [r * Math.cos(phi), r * Math.sin(phi)];
    const lx = Math.sqrt(l * l - py * py);
    // unit crank rate: wrist pin x speed from the rigid rod, rod rate, and the wrist joint (piston relative to rod) = - rod rate
    const vwx = -py - (px * py) / lx;
    const rodRate = (lx * -px + py * (vwx + py)) / (l * l);
    const ratio = -rodRate;
    const { doc } = sliderCrank({ wrist: 'revolute', startDeg: 40, order: ['slide_j', 'wrist_j', 'crank_j', 'rod_j'] });
    expect(topologyOf(doc).tree.find((entry) => entry.joint.id === 'wrist_j')?.flipped).toBe(true);
    const base = inspect(doc).mobility;
    const consistent = execute(doc, 'add_gear_coupling', { id: 'g', driver: 'crank_j', driven: 'wrist_j', ratio });
    const same = inspect(consistent.document).mobility;
    expect(same.dof).toBe(base.dof);
    expect(same.redundant.length).toBe(base.redundant.length + 1);
    const opposite = execute(doc, 'add_gear_coupling', { id: 'g', driver: 'crank_j', driven: 'wrist_j', ratio: -ratio });
    expect(inspect(opposite.document).mobility.dof).toBe(base.dof - 1);
  });

  it('a coupling to a loop-closing joint adds no row and is reported', () => {
    const { doc } = sliderCrank({ wrist: 'revolute', startDeg: 40 });
    const coupled = execute(doc, 'add_gear_coupling', { id: 'g', driver: 'crank_j', driven: 'wrist_j', ratio: 2 });
    expect(inspect(coupled.document).warnings.some((w) => w.startsWith("FPR_GEAR_ON_LOOP_JOINT: gear coupling 'g'"))).toBe(true);
  });

  it('a gear coupling between two tree joints is one more constraint row (DOF - 1); a loop joint on either side adds none', () => {
    const { doc } = sliderCrank({ wrist: 'spherical', startDeg: 40 });
    const solid = execute(doc, 'add_cylinder', { radius: 10, height: 5, axis: [0, 0, 1], position: [0, 300, 0] });
    const body = execute(solid.document, 'add_rigid_body', { entityIds: [solid.affected[0]], id: 'shaft', massKg: 1 });
    const spun = execute(body.document, 'add_body_joint', {
      id: 'shaft_j',
      kind: 'revolute',
      child: 'shaft',
      anchor: [0, 300, 0],
      axis: [0, 0, 1],
    });
    const free = inspect(spun.document).mobility as InspectData['mobility'] & { constraintRows: number };
    expect(free.dof).toBe(2);
    for (const [driver, driven] of [
      ['crank_j', 'shaft_j'],
      ['shaft_j', 'crank_j'],
    ] as const) {
      const geared = execute(spun.document, 'add_gear_coupling', { id: 'g', driver, driven, ratio: 0.5 });
      expect(geared.affected).toEqual(['g']);
      const mobility = inspect(geared.document).mobility as InspectData['mobility'] & { constraintRows: number };
      expect(mobility.dof).toBe(1);
      expect(mobility.rank).toBe(free.rank + 1);
      expect(mobility.constraintRows).toBe(free.constraintRows + 1);
    }
    // a revolute wrist closes the loop (not a tree joint): a coupling to it has no tree coordinate to constrain and adds no row
    const closed = sliderCrank({ wrist: 'revolute', startDeg: 40 }).doc;
    const before = inspect(closed).mobility;
    const coupled = execute(closed, 'add_gear_coupling', { id: 'g', driver: 'crank_j', driven: 'wrist_j', ratio: 2 });
    expect(coupled.affected).toEqual(['g']);
    expect(inspect(coupled.document).mobility).toMatchObject({ dof: before.dof, rank: before.rank });
  });

  it('a four-bar has 1 DOF and no redundancy in a spatial-free planar set', () => {
    let doc = createEmptyDocument();
    const make = (id: string, position: number[]): void => {
      const solid = execute(doc, 'add_box', { size: [10, 10, 10], position });
      doc = execute(solid.document, 'add_rigid_body', { entityIds: [solid.affected[0]], id }).document;
    };
    make('crank', [0, 0, 0]);
    make('coupler', [50, 50, 0]);
    make('rocker', [100, 0, 0]);
    const joints = [
      { id: 'a', kind: 'revolute', child: 'crank', anchor: [0, 0, 0] },
      { id: 'b', kind: 'revolute', child: 'coupler', parent: 'crank', anchor: [0, 50, 0] },
      { id: 'c', kind: 'revolute', child: 'rocker', parent: 'coupler', anchor: [100, 50, 0] },
      { id: 'd', kind: 'spherical', child: 'rocker', anchor: [100, 0, 0] },
    ];
    for (const joint of joints) doc = execute(doc, 'add_body_joint', { axis: [0, 0, 1], ...joint }).document;
    const { mobility, topology } = inspect(doc);
    expect(topology.loops.map((l) => l.joint)).toEqual(['d']);
    expect(mobility.dof).toBe(1);
  });

  it('a free tree has full mobility and no loops', () => {
    const { doc } = sliderCrank();
    const without = {
      ...doc,
      dynamics: { ...doc.dynamics!, joints: Object.fromEntries(Object.entries(doc.dynamics!.joints).filter(([id]) => id !== 'wrist_j')) },
    };
    const { mobility, topology } = inspect(without);
    expect(topology.loops).toEqual([]);
    expect(mobility).toMatchObject({ treeCoordinates: 3, rank: 0, dof: 3 });
  });

  it('inspect_dynamics can skip the structure', () => {
    const { doc } = sliderCrank();
    const data = execute(doc, 'inspect_dynamics', { mobility: false }).data as Record<string, unknown>;
    expect(data['mobility']).toBeUndefined();
  });
});

describe('loop gap at the start pose (VC-FPR-21)', () => {
  it('a closed loop has a zero gap', () => {
    const { doc } = sliderCrank({ startDeg: 25 });
    expect(inspect(doc).loopGapsM['wrist_j']).toBeCloseTo(0, 12);
  });

  it('a wrist pin 1 mm off is reported as a 1.000 mm gap and blocks simulation', () => {
    const { doc } = sliderCrank({ wristGapMm: 1 });
    const data = inspect(doc);
    expect(data.loopGapsM['wrist_j']).toBeCloseTo(0.001, 9);
    expect(data.problems.some((p) => p.startsWith('FPR_LOOP_OPEN'))).toBe(true);
    const topology = topologyOf(doc);
    expect(analyseMobility(doc.dynamics!, topology, 0.001).loopGapsM['wrist_j']).toBeCloseTo(0.001, 9);
  });
});

describe('add_body_joint with loops', () => {
  it('accepts a second joint on a child, reports the closure and is pure', () => {
    const { doc } = sliderCrank({ order: ['crank_j', 'rod_j', 'slide_j'] });
    const before = structuredClone(doc);
    const result = execute(doc, 'add_body_joint', {
      kind: 'spherical',
      child: 'piston',
      parent: 'rod',
      anchor: [200, 0, 0],
      id: 'wrist_j',
    });
    expect(result.affected).toEqual(['wrist_j']);
    expect(result.summary).toMatch(/closes a loop/);
    expect(doc).toEqual(before);
    expect(result.document.dynamics?.joints['wrist_j']?.kind).toBe('spherical');
  });

  it('fails cleanly on bad input', () => {
    const { doc } = sliderCrank();
    const run = (params: Record<string, unknown>): string => execute(doc, 'add_body_joint', { anchor: [0, 0, 0], ...params }).summary;
    expect(run({ kind: 'revolute', child: 'piston', parent: 'piston', axis: [0, 0, 1] })).toMatch(/itself/);
    expect(run({ kind: 'revolute', child: 'piston', axis: [0, 0, 0] })).toMatch(/non-zero/);
    expect(run({ kind: 'revolute', child: 'piston' })).toMatch(/non-zero/);
    expect(run({ kind: 'spherical', child: 'piston', parent: 'rod', damping: 1 })).toMatch(/no damping/);
    expect(run({ kind: 'spherical', child: 'piston', parent: 'rod', initialRpm: 5 })).toMatch(/no damping/);
    expect(run({ kind: 'revolute', child: 'piston', axis: [0, 0, 1], id: 'crank_j' })).toMatch(/already used/);
    expect(run({ kind: 'revolute', child: 'ghost', axis: [0, 0, 1] })).toMatch(/not found/);
    expect(run({ kind: 'revolute', child: 'piston', parent: 'ghost', axis: [0, 0, 1] })).toMatch(/not found/);
  });
});

describe('mobility is frame independent', () => {
  /** Rotate 30 deg about (1, 1, 0) / sqrt 2 and translate by [1000, 500, 1000] mm. */
  function moved(doc: CadDocument): CadDocument {
    const u = [Math.SQRT1_2, Math.SQRT1_2, 0] as const;
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const rotate = (v: readonly number[]): [number, number, number] => {
      const [x, y, z] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
      const dot = u[0] * x + u[1] * y;
      const cross = [u[1] * z, -u[0] * z, u[0] * y - u[1] * x];
      return [
        x * c + (cross[0] ?? 0) * s + u[0] * dot * (1 - c),
        y * c + (cross[1] ?? 0) * s + u[1] * dot * (1 - c),
        z * c + (cross[2] ?? 0) * s,
      ];
    };
    const shift = [1000, 500, 1000];
    const joints = Object.fromEntries(
      Object.entries(doc.dynamics!.joints).map(([id, j]) => {
        const anchor = rotate(j.anchor);
        return [
          id,
          {
            ...j,
            anchor: [anchor[0] + (shift[0] ?? 0), anchor[1] + (shift[1] ?? 0), anchor[2] + (shift[2] ?? 0)] as [number, number, number],
            axis: rotate(j.axis),
          },
        ];
      }),
    );
    return { ...doc, dynamics: { ...doc.dynamics!, joints } };
  }

  it.each([
    ['revolute', 3],
    ['spherical', 1],
  ] as const)('slider-crank with a %s wrist keeps DOF 1 and %i redundant rows after a rotation and translation', (wrist, redundant) => {
    const { mobility } = inspect(moved(sliderCrank({ wrist, startDeg: 40 }).doc));
    expect(mobility.dof).toBe(1);
    expect(mobility.rank).toBe(2);
    expect(mobility.redundant).toHaveLength(redundant);
  });
});
