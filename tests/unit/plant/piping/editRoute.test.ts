/**
 * `edit_route` (02 RTE §4, M3): move a point of intersection (orthogonal stretch or free), stretch a leg, insert and delete points of intersection;
 * inline components, branches and leg slopes are re-indexed with the merged legs; attached runs follow; every failure refuses with a stable code.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, routedPumpToVessel, routedPumpToVesselWithTee } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const runOf = (doc: CadDocument, id: string): PipeRun => piping(doc).runs[id] as PipeRun;
const cuts = (doc: CadDocument, runId: string): number[] =>
  data<{ pipePieces: Array<{ cutLengthMm: number }> }>(doc, 'piping_takeoff', { runId }).pipePieces.map((piece) => piece.cutLengthMm);

interface EditData {
  runId: string;
  pis: number[][];
  legs: Array<{ index: number; direction: string | number[]; lengthMm: number }>;
  legChanges: Array<{ leg: number; changeMm: number }>;
  remapped: string[];
  dependents: string[];
}

/** A -> +X 2000 -> +Y 2000, open end; DN100 BW. */
function simpleRun(): { doc: CadDocument; runId: string; lineId: string } {
  const { doc: withLine, lineId } = cs150Line();
  const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 2000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  return { doc, runId: piping(doc).runOrder[0] as string, lineId };
}

const JOG = [
  [2000, 800, 0],
  [2000, 800, 500],
  [2000, 1300, 500],
  [2000, 1300, 0],
];

describe('edit_route: SC-RTE-01 run between two nozzles', () => {
  const s = routedPumpToVessel();

  it('move_pi (orthogonal) up 500: the +Z leg grows, the last +Z leg absorbs it, the ends stay on their nozzles', () => {
    const result = ok(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [0, 0, 500] });
    expect(cuts(result.document, s.runId)).toEqual([1769, 2696, 2696, 696, 2769]);
    const run = runOf(result.document, s.runId);
    expect(run.pis).toEqual([
      [0, 0, 3000],
      [0, 3000, 3000],
      [3000, 3000, 3000],
      [3000, 3000, 4000],
    ]);
    expect(run.start.point).toEqual([0, 0, 1000]);
    expect(run.end.point).toEqual([6000, 3000, 4000]);
    expect((result.data as EditData).legChanges.map((change) => change.changeMm)).toEqual([500, -500]);
    expect(result.affected[0]).toBe(s.runId);
  });

  it('move_pi by point gives the same result as the delta', () => {
    const byPoint = apply(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, point: [0, 0, 3000] });
    expect(runOf(byPoint, s.runId).pis[0]).toEqual([0, 0, 3000]);
  });

  it('stretch_leg 2 to 3500 pushes the later PIs +500 X and the last leg (+X) shortens', () => {
    const result = ok(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 2, length: 3500 });
    expect(cuts(result.document, s.runId)).toEqual([1269, 2696, 3196, 1196, 2269]);
    expect(runOf(result.document, s.runId).pis[2]).toEqual([3500, 3000, 2500]);
  });

  it('a stretch no leg can absorb is refused: both ends are fixed and nothing else is parallel to Y (RTE_STRETCH_FAILED)', () => {
    const result = expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 1, length: 3500 }, 'RTE_STRETCH_FAILED');
    expect(result.error?.detail).toMatchObject({ side: 'after' });
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [0, 500, 0] }, 'RTE_STRETCH_FAILED');
  });

  it('a leg that would vanish is refused with the leg named', () => {
    const result = expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 2, length: 6100 }, 'RTE_STRETCH_FAILED');
    expect(result.summary).toContain('leg 4');
  });

  it('move_pi mode free turns the two legs at the point (a 10 mm lift on a 3000 mm leg is inside the 1 degree tolerance)', () => {
    const result = ok(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 1, delta: [0, 0, 10], mode: 'free' });
    const legs = (result.data as EditData).legs;
    expect(legs[1]?.direction).toEqual(expect.any(Array));
    expect(runOf(result.document, s.runId).pis[1]).toEqual([0, 3000, 2510]);
    // A lift that tilts the legs past the spec tolerance is refused by the derivation.
    expectRefusal(
      s.doc,
      'edit_route',
      { runId: s.runId, op: 'move_pi', index: 1, delta: [0, 0, 400], mode: 'free' },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
  });

  it('removing the PI next to the start leaves the first leg off the nozzle axis: RTE_PORT_DIRECTION', () => {
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 0 }, 'RTE_PORT_DIRECTION');
  });

  it('is pure and the edited model equals what a load re-derives', () => {
    const before = JSON.stringify(s.doc);
    const result = execute(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [0, 0, 500] });
    expect(JSON.stringify(s.doc)).toBe(before);
    const loaded = deserializeDocument(serializeDocument(result.document));
    expect(loaded.plant).toEqual(result.document.plant);
  });
});

describe('edit_route: insert_pi and delete_pi re-index components, branches and slopes', () => {
  it('inserts a jog into the last leg: PIs 1 -> 5, legs 2 -> 6, the valve moves with the end of its leg', () => {
    const s = simpleRun();
    const valved = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1800 } });
    const jogged = ok(valved, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 1, points: JOG });
    const edit = jogged.data as EditData;
    expect(edit.pis).toHaveLength(5);
    expect(edit.legs).toHaveLength(6);
    expect(edit.remapped).toHaveLength(1);
    expect(edit.remapped[0]).toContain('leg 1 @ 1800 -> leg 5 @ 500');
    expect(runOf(jogged.document, s.runId).inline?.[0]).toMatchObject({ leg: 5, centreDistance: 500 });
    // Deleting the jog restores the straight leg and the valve at its old place.
    const back = ok(jogged.document, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 1, count: 4 });
    expect(runOf(back.document, s.runId).pis).toEqual(runOf(s.doc, s.runId).pis);
    expect(runOf(back.document, s.runId).inline?.[0]).toMatchObject({ leg: 1, centreDistance: 1800 });
  });

  it('inserting a point on the leg itself changes nothing: collinear points merge and the edit is a no-op', () => {
    const s = simpleRun();
    const result = execute(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 0, points: [[1000, 0, 0]] });
    expect(result.rejected).toBeUndefined();
    expect(result.document).toBe(s.doc);
    expect(result.summary).toContain('no change');
  });

  it('a component on a leg the deletion removes refuses the edit and names the leg', () => {
    const s = routedPumpToVessel();
    const valved = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } });
    const result = expectRefusal(valved, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 0, count: 2 }, 'RTE_EDIT_INVALID');
    expect(result.summary).toContain('leg 1');
  });

  it('a branch on a leg the deletion removes refuses the edit and names the branch', () => {
    const s = routedPumpToVesselWithTee();
    const result = expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 0, count: 2 }, 'RTE_EDIT_INVALID');
    expect(result.summary).toContain('branch');
    expect(result.error?.detail).toMatchObject({ id: expect.stringMatching(/^branch-/) });
  });

  it('a free move re-places a valve on the leg whose start moved by the change of that leg (it keeps its distance from the end)', () => {
    const s = routedPumpToVessel();
    const valved = apply(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 1, centreDistance: 1500 } });
    const moved = ok(valved, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [0, 0, 10], mode: 'free' });
    const valve = runOf(moved.document, s.runId).inline?.[0];
    expect(valve?.leg).toBe(1);
    // leg 1 runs from the lifted PI (0, 0, 2510) to (0, 3000, 2500): 3000.0167 long instead of 3000.
    expect(valve?.centreDistance).toBeCloseTo(1500 + (Math.hypot(3000, 10) - 3000), 9);
    expect((moved.data as EditData).remapped).toHaveLength(1);
  });

  it('a free move that tilts the header leg off the perpendicular of its tee refuses the edit (branch angle is judged by the derivation)', () => {
    const base = routedPumpToVessel();
    const added = ok(base.doc, 'add_branch', {
      runId: base.runId,
      at: { leg: 1, distance: 1500 },
      dn: 100,
      legs: [{ direction: '-X', length: 5000 }],
    });
    const branchId = (added.data as { branchId: string }).branchId;
    const result = expectRefusal(
      added.document,
      'edit_route',
      { runId: base.runId, op: 'move_pi', index: 1, delta: [1500, -1500, 0], mode: 'free' },
      'RTE_NO_FITTING_FOR_ANGLE',
    );
    expect(result.error?.ids).toContain(branchId);
    expect(result.error?.detail).toMatchObject({ branch: branchId, anglesDeg: [90] });
  });

  it('a summary of an edit that merges or splits legs gives the new leg count and lengths, not "no leg changed"', () => {
    const s = simpleRun();
    const jogged = ok(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 1, points: JOG });
    expect(jogged.summary).toContain('legs 2 -> 6');
    expect(jogged.summary).not.toContain('no leg changed');
    const back = ok(jogged.document, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 1, count: 4 });
    expect(back.summary).toContain('legs 6 -> 2');
  });

  it('insert_pi with a leg index out of range is refused', () => {
    const s = simpleRun();
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 7, points: [[1, 2, 3]] }, 'RTE_EDIT_INVALID', 'index');
  });

  it('declared leg slopes follow the legs: a stretch keeps them, a free lift that tilts the leg against its fall is reported as adverse', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 1000], [1, 0, 0]);
    const doc = apply(a.doc, 'route_pipe', {
      lineId,
      from: { portId: a.id },
      legs: [
        { direction: '+X', planLength: 8000, slope: { value: 1, unit: 'percent', fall: true } },
        { direction: '-Z', length: 500 },
      ],
    });
    const runId = piping(doc).runOrder[0] as string;
    expect(runOf(doc, runId).legSlopes).toEqual([{ value: 1, unit: 'percent', fall: true }, null]);
    const stretched = apply(doc, 'edit_route', { runId, op: 'stretch_leg', index: 1, length: 700 });
    expect(runOf(stretched, runId).legSlopes).toEqual(runOf(doc, runId).legSlopes);
    const lifted = apply(doc, 'edit_route', { runId, op: 'move_pi', index: 0, delta: [0, 0, 200], mode: 'free' });
    expect(runOf(lifted, runId).legSlopes).toEqual(runOf(doc, runId).legSlopes);
    const issues = data<{ issues: Array<{ code: string }> }>(lifted, 'check_piping', {}).issues.map((issue) => issue.code);
    expect(issues).toContain('RTE_ADVERSE_SLOPE');
  });
});

describe('edit_route: attached runs and broken runs', () => {
  it('a branch on an edited leg follows the header and keeps its distance from the leg start', () => {
    const s = routedPumpToVesselWithTee();
    const result = ok(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [0, 0, 500] });
    expect((result.data as EditData).dependents).toEqual([s.branchRunId]);
    expect(runOf(result.document, s.branchRunId).start.point).toEqual([0, 1500, 3000]);
    expect(runOf(result.document, s.branchRunId).end.point).toEqual([1000, 1500, 3000]);
    expect(result.affected).toEqual([s.runId, s.branchRunId]);
  });

  it('repairs a run broken by a moved port: the end follows its port as part of the edit', () => {
    const line = cs150Line();
    const a = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0]);
    const b = addTie(a.doc, 'B', [4000, 3000, 0], [-1, 0, 0]);
    const routed = apply(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      legs: [
        { direction: '+X', length: 2000 },
        { direction: '+Y', length: 3000 },
      ],
    });
    const runId = piping(routed).runOrder[0] as string;
    const model = piping(routed);
    const tie = model.tieIns[b.id] as NonNullable<(typeof model.tieIns)[string]>;
    const raised: CadDocument = {
      ...routed,
      plant: {
        ...routed.plant,
        piping: { ...model, tieIns: { ...model.tieIns, [b.id]: { ...tie, port: { ...tie.port, position: [4000, 3000, 400] } } } },
      },
    };
    const broken = pipingDocument.reconcile?.(routed, raised).document as CadDocument;
    expect(runOf(broken, runId).broken?.code).toBe('RTE_STRETCH_FAILED');
    const repaired = ok(broken, 'edit_route', {
      runId,
      op: 'insert_pi',
      index: 2,
      points: [
        [2500, 3000, 0],
        [2500, 3000, 400],
      ],
    });
    expect(runOf(repaired.document, runId).broken).toBeUndefined();
    expect(runOf(repaired.document, runId).end.point).toEqual([4000, 3000, 400]);
    expect(cuts(repaired.document, runId)).toEqual([1848, 2696, 196, 96, 1348]);
  });
});

describe('edit_route: refusals', () => {
  const s = simpleRun();

  it('unknown run, index out of range, parameters that do not belong to the op, both delta and point', () => {
    expectRefusal(s.doc, 'edit_route', { runId: 'run-99', op: 'move_pi', index: 0, delta: [1, 0, 0] }, 'RTE_UNKNOWN_RUN');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 4, delta: [1, 0, 0] }, 'RTE_EDIT_INVALID', 'index');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 9, length: 100 }, 'RTE_EDIT_INVALID');
    expectRefusal(
      s.doc,
      'edit_route',
      { runId: s.runId, op: 'stretch_leg', index: 0, length: 100, delta: [1, 0, 0] },
      'RTE_EDIT_INVALID',
      'delta',
    );
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 0 }, 'RTE_EDIT_INVALID', 'length');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [1, 0, 0], point: [1, 1, 1] }, 'RTE_EDIT_INVALID');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0 }, 'RTE_EDIT_INVALID');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 0 }, 'RTE_EDIT_INVALID', 'points');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 0, count: 3 }, 'RTE_EDIT_INVALID');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'delete_pi', index: 0, mode: 'free' }, 'RTE_EDIT_INVALID', 'mode');
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, point: [2000, 0, 0] }, 'RTE_EDIT_INVALID');
  });

  it('a connected end cannot be moved by an edit; an open one can be stretched', () => {
    const open = ok(s.doc, 'edit_route', { runId: s.runId, op: 'stretch_leg', index: 1, length: 2500 });
    expect(runOf(open.document, s.runId).end.point).toEqual([2000, 2500, 0]);
    const routed = routedPumpToVessel();
    expectRefusal(routed.doc, 'edit_route', { runId: routed.runId, op: 'stretch_leg', index: 4, length: 3500 }, 'RTE_STRETCH_FAILED');
  });

  it('a zero-length result is RTE_ZERO_LEG; a non-mm document is RTE_UNITS_UNSUPPORTED', () => {
    expectRefusal(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 0, points: [[0, 0, 0]] }, 'RTE_ZERO_LEG');
    const metres = apply(s.doc, 'set_units', { units: 'm' });
    expectRefusal(metres, 'edit_route', { runId: s.runId, op: 'move_pi', index: 0, delta: [1, 0, 0] }, 'RTE_UNITS_UNSUPPORTED');
  });
});
