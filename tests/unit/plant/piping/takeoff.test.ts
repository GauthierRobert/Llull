/** `piping_takeoff` (02 RTE §4): counts, cut list, joints, totals and trust of derived runs (VC-RTE-01..03, VC-RTE-21). */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { takeoffOf } from '@aec/plant/piping/takeoff';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, routedPumpToVessel, withoutSpecs } from './rteFixtures';

interface Takeoff {
  runs: string[];
  counts: Record<string, number>;
  parts: Array<{ id: string; kind: string; typeKey: string; cutLengthMm?: number; angleDeg?: number; studs?: number; unverified: boolean }>;
  pipePieces: Array<{ id: string; runId: string; cutLengthMm: number; leg: number; dn: number }>;
  joints: Array<{ kind: string }>;
  totalPipeMm: number;
  centrelineLengthMm: number;
  legs: Array<{ runId: string; index: number }>;
  turns: Array<{ runId: string; turnDeg: number; nominalDeg: number }>;
  studs: number;
  unverified: boolean;
  unverifiedReasons: string[];
}

describe('piping_takeoff: SC-RTE-01', () => {
  const s = routedPumpToVessel();
  const takeoff = data<Takeoff>(s.doc, 'piping_takeoff', { runId: s.runId });

  it('lists the cut pieces, totals and counts the route reported', () => {
    expect(takeoff.runs).toEqual([s.runId]);
    expect(takeoff.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([1269, 2696, 2696, 1196, 2769]);
    expect(takeoff.totalPipeMm).toBeCloseTo(10626, 2);
    expect(takeoff.centrelineLengthMm).toBeCloseTo(11739.044, 2);
    expect(takeoff.studs).toBe(16);
    expect(takeoff.counts).toEqual({
      pipePieces: 5,
      buttWelds: 10,
      socketWelds: 0,
      threadedJoints: 0,
      flangedJoints: 2,
      fittingToFitting: 0,
      gasketSpiralWound: 2,
      boltSet: 2,
      flangeWeldNeck: 2,
      elbow90LR: 4,
      studs: 16,
    });
    expect(takeoff.joints).toHaveLength(12);
    expect(takeoff.legs.map((leg) => leg.index)).toEqual([0, 1, 2, 3, 4]);
    expect(takeoff.turns.map((turn) => [turn.turnDeg, turn.nominalDeg])).toEqual([
      [90, 90],
      [90, 90],
      [90, 90],
      [90, 90],
    ]);
  });

  it('lists every part with its key, cut length, elbow angle and stud count', () => {
    expect(takeoff.parts).toHaveLength(15);
    const piece = takeoff.parts.find((part) => part.id.endsWith('/pipe-1'));
    expect(piece).toMatchObject({ kind: 'pipe', typeKey: 'pipe', cutLengthMm: 1269, unverified: false });
    expect(takeoff.parts.find((part) => part.id.endsWith('/elbow-1'))).toMatchObject({
      typeKey: 'elbow90LR',
      angleDeg: 90,
      unverified: true,
    });
    expect(takeoff.parts.find((part) => part.id.endsWith('/boltSet-2'))).toMatchObject({ studs: 8 });
  });

  it('is unverified while the spec is a draft or a row is not grade A, and says why (VC-RTE-21)', () => {
    expect(takeoff.unverified).toBe(true);
    expect(takeoff.unverifiedReasons).toHaveLength(2);
    expect(takeoff.unverifiedReasons[0]).toContain('draft');
  });

  it('with only grade A rows the sole reason left is the spec status', () => {
    const { doc: withLine, lineId } = cs150Line();
    const bundledOnly = apply(withLine, 'edit_pipe_spec', {
      specId: 'CS150',
      ops: [{ op: 'setHeader', fields: { catalogs: ['llull-open-piping'] } }],
    });
    const routed = apply(bundledOnly, 'route_pipe', {
      lineId,
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [
        { direction: '+X', length: 2000 },
        { direction: '+Y', length: 2000 },
      ],
    });
    const result = data<Takeoff>(routed, 'piping_takeoff', {});
    // Bundled B16.9 NPS 4 LR A is 152.4 (grade A): cut = 2000 - 152.4.
    expect(result.pipePieces[0]?.cutLengthMm).toBeCloseTo(1847.6, 6);
    expect(result.unverifiedReasons).toEqual(['spec CS150 r1 is draft, not approved']);
  });

  it('is derived afresh: a spec edit changes the numbers without touching the stored run', () => {
    const edited = apply(s.doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'setHeader', fields: { title: 'retitled' } }] });
    expect(data<Takeoff>(edited, 'piping_takeoff', { runId: s.runId }).pipePieces).toEqual(takeoff.pipePieces);
  });

  it('is read-only and pure', () => {
    const before = structuredClone(s.doc);
    const result = ok(s.doc, 'piping_takeoff', {});
    expect(result.document).toBe(s.doc);
    expect(result.affected).toEqual([]);
    expect(s.doc).toEqual(before);
    expect(result.summary).toContain('5 pipe piece(s)');
  });
});

describe('piping_takeoff scope and refusals', () => {
  function twoRuns(): { doc: CadDocument; first: string; second: string; line: string } {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
    const one = ok(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const b = addTie(one.document, 'B', [0, 3000, 0], [1, 0, 0]);
    const two = ok(b.doc, 'route_pipe', { lineId, from: { portId: b.id }, legs: [{ direction: '+X', length: 3000 }] });
    return { doc: two.document, first: one.affected[0] as string, second: two.affected[0] as string, line: lineId };
  }

  it('counts every run when neither runId nor lineId is given, one line when lineId is, one run when runId is', () => {
    const s = twoRuns();
    const all = data<Takeoff>(s.doc, 'piping_takeoff', {});
    expect(all.runs).toEqual([s.first, s.second]);
    expect(all.totalPipeMm).toBe(5000);
    expect(all.counts['pipePieces']).toBe(2);
    expect(data<Takeoff>(s.doc, 'piping_takeoff', { lineId: s.line }).runs).toEqual([s.first, s.second]);
    const only = data<Takeoff>(s.doc, 'piping_takeoff', { runId: s.second });
    expect(only.totalPipeMm).toBe(3000);
    expect(only.legs.every((leg) => leg.runId === s.second)).toBe(true);
    expect(data<Takeoff>(s.doc, 'piping_takeoff', { runId: s.first, lineId: s.line }).runs).toEqual([s.first]);
  });

  it('answers an empty document with zero counts', () => {
    const empty = data<Takeoff>(cs150Line().doc, 'piping_takeoff', {});
    expect(empty.runs).toEqual([]);
    expect(empty.totalPipeMm).toBe(0);
    expect(empty.unverified).toBe(false);
  });

  it('refuses an unknown run or line (RTE_UNKNOWN_RUN, RTE_UNKNOWN_LINE) and a run that no longer derives', () => {
    const s = twoRuns();
    expectRefusal(s.doc, 'piping_takeoff', { runId: 'run-nope' }, 'RTE_UNKNOWN_RUN', 'runId');
    expectRefusal(s.doc, 'piping_takeoff', { lineId: 'line-nope' }, 'RTE_UNKNOWN_LINE', 'lineId');
    const broken = withoutSpecs(s.doc);
    const result = expectRefusal(broken, 'piping_takeoff', { runId: s.first }, 'RTE_SPEC_UNKNOWN');
    expect(result.summary).toContain(s.first);
    expect(execute(broken, 'piping_takeoff', {}).error?.ids).toContain(s.first);
  });
});

describe('takeoffOf', () => {
  it('aggregates nothing into an empty takeoff', () => {
    const empty = takeoffOf([]);
    expect(empty.parts).toEqual([]);
    expect(empty.totalPipeMm).toBe(0);
    expect(empty.unverified).toBe(false);
  });
});
