/**
 * Plant 02 RTE V1: slope-preserving stretch. A horizontal move of the end of a sloped leg changes the plan length and the drop together (the slope is the
 * direction of the leg), and the leg after it takes the vertical difference. Hand calculations on the SC-RTE-04 drain: DN50, 1 % fall over 8000 plan from
 * TP-D1 (0, 0, 1000) to a hub at (8000, 0, 0); NPS 2 LR elbow A = 76.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { walkChain } from '@aec/plant/piping/stretchWalk';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const S = 0.01;
const SLOPE = { value: 1, unit: 'percent', fall: true } as const;
const slopedLength = (plan: number): number => plan * Math.sqrt(1 + S * S);

/** The drain: DN50, sloped leg then a closing vertical leg down to the hub. */
function drain(): { doc: CadDocument; runId: string; hub: string; start: string } {
  const line = cs150Line(50, '6001');
  const a = addTie(line.doc, 'TP-D1', [0, 0, 1000], [1, 0, 0], { dn: 50 });
  const b = addTie(a.doc, 'TP-D2', [8000, 0, 0], [0, 0, 1], { dn: 50 });
  const routed = ok(b.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: a.id },
    to: { portId: b.id },
    legs: [{ direction: '+X', planLength: 8000, slope: SLOPE }],
  });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId, hub: b.id, start: a.id };
}

/** `doc` with tie-in `id` moved to `position`, reconciled the way `execute` does after a command. */
function moveTie(doc: CadDocument, id: string, position: [number, number, number]): { document: CadDocument; notes: readonly string[] } {
  const model = piping(doc);
  const tie = model.tieIns[id] as NonNullable<(typeof model.tieIns)[string]>;
  const moved: CadDocument = {
    ...doc,
    plant: { ...doc.plant, piping: { ...model, tieIns: { ...model.tieIns, [id]: { ...tie, port: { ...tie.port, position } } } } },
  };
  const result = pipingDocument.reconcile?.(doc, moved);
  return { document: result?.document ?? moved, notes: result?.notes ?? [] };
}

const cuts = (doc: CadDocument, runId: string): number[] =>
  data<{ pipePieces: Array<{ cutLengthMm: number }> }>(doc, 'piping_takeoff', { runId }).pipePieces.map((piece) => piece.cutLengthMm);
const runOf = (doc: CadDocument, runId: string): PipeRun => piping(doc).runs[runId] as PipeRun;

describe('walkChain keeps every leg direction, also for a sloped leg', () => {
  const sloped: [number, number, number] = [Math.cos(Math.atan(S)), 0, -Math.sin(Math.atan(S))];

  it('the hub moves 500 along X: the sloped leg lengthens along its own direction (plan +500, drop +5), the vertical leg takes the 5', () => {
    const result = walkChain([sloped, [0, 0, -1]], [0, 0, 0], [500, 0, 0], 1e-6);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displacements[0]).toEqual([0, 0, 0]);
    expect(result.displacements[1]?.[0]).toBeCloseTo(500, 9);
    expect(result.displacements[1]?.[1]).toBeCloseTo(0, 9);
    expect(result.displacements[1]?.[2]).toBeCloseTo(-5, 9);
    expect(result.displacements[2]).toEqual([500, 0, 0]);
  });

  it('a move across the plan direction cannot keep the heading: the failure of the orthogonal walk is returned', () => {
    const result = walkChain([sloped, [0, 0, -1]], [0, 0, 0], [0, 500, 0], 1e-6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.at).toBe('first');
    expect(result.remainder[1]).toBeCloseTo(500, 9);
  });

  it('orthogonal chains are unchanged: the SC-RTE-06 walk still answers', () => {
    const result = walkChain(
      [
        [0, 0, 1],
        [0, 1, 0],
      ],
      null,
      [0, 300, 0],
      1e-6,
    );
    expect(result.ok && result.displacements).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 300, 0],
    ]);
  });
});

describe('the drain follows its hub when it moves along the plan direction', () => {
  const s = drain();

  it('baseline: sloped leg 8000.39999 - 76 = 7924.39999, vertical 920 - 76 = 844 (SC-RTE-04)', () => {
    expect(cuts(s.doc, s.runId)).toEqual([expect.closeTo(slopedLength(8000) - 76, 6), 844]);
  });

  it('hub +500 X: plan 8500, drop 85, the vertical leg 915: cuts 8500 sqrt(1 + 0.01^2) - 76 = 8424.42499 and 915 - 76 = 839', () => {
    const moved = moveTie(s.doc, s.hub, [8500, 0, 0]);
    expect(moved.notes.join(' ')).toContain('orthogonal stretch');
    const run = runOf(moved.document, s.runId);
    expect(run.broken).toBeUndefined();
    expect(run.pis).toHaveLength(1);
    expect(run.pis[0]?.[0]).toBeCloseTo(8500, 9);
    expect(run.pis[0]?.[2]).toBeCloseTo(915, 9);
    expect(cuts(moved.document, s.runId)).toEqual([expect.closeTo(slopedLength(8500) - 76, 6), expect.closeTo(839, 6)]);
    expect(run.legSlopes?.[0]).toEqual(SLOPE);
    const legs = data<{ legs: Array<{ planLengthMm?: number; dropMm?: number; slopeDeg?: number }> }>(moved.document, 'piping_takeoff', {
      runId: s.runId,
    }).legs;
    expect(legs[0]?.planLengthMm).toBeCloseTo(8500, 5);
    expect(legs[0]?.dropMm).toBeCloseTo(85, 5);
    expect(legs[0]?.slopeDeg).toBeCloseTo(0.572939, 5);
  });

  it('hub 500 along X and 200 lower together: the sloped leg still keeps 1 %, the vertical leg is 195 longer than before the slope change (1115 - 76)', () => {
    const moved = moveTie(s.doc, s.hub, [8500, 0, -200]);
    const run = runOf(moved.document, s.runId);
    expect(run.broken).toBeUndefined();
    expect(run.pis[0]?.[2]).toBeCloseTo(915, 9);
    expect(cuts(moved.document, s.runId)[1]).toBeCloseTo(915 + 200 - 76, 6);
  });

  it('shorter the other way: hub -1000 X gives plan 7000, drop 70, vertical 930', () => {
    const moved = moveTie(s.doc, s.hub, [7000, 0, 0]);
    expect(runOf(moved.document, s.runId).pis[0]?.[2]).toBeCloseTo(930, 9);
    expect(cuts(moved.document, s.runId)[0]).toBeCloseTo(slopedLength(7000) - 76, 6);
  });

  it('both ends move: the start 100 along X and the hub 500: plan 8400', () => {
    const first = moveTie(s.doc, s.start, [100, 0, 1000]);
    const both = moveTie(first.document, s.hub, [8500, 0, 0]);
    expect(runOf(both.document, s.runId).broken).toBeUndefined();
    expect(cuts(both.document, s.runId)[0]).toBeCloseTo(slopedLength(8400) - 76, 4);
  });

  it('the stretched model equals what a load re-derives, and moving the hub back restores the original run', () => {
    const moved = moveTie(s.doc, s.hub, [8500, 0, 0]);
    const loaded = deserializeDocument(serializeDocument(moved.document));
    expect(loaded.plant).toEqual(moved.document.plant);
    const back = moveTie(moved.document, s.hub, [8000, 0, 0]);
    expect(runOf(back.document, s.runId).pis).toEqual(runOf(s.doc, s.runId).pis);
    expect(cuts(back.document, s.runId)).toEqual(cuts(s.doc, s.runId));
  });

  it('a move across the heading still breaks the run with RTE_STRETCH_FAILED (use edit_route), the stored run is kept as routed', () => {
    const moved = moveTie(s.doc, s.hub, [8000, 500, 0]);
    const run = runOf(moved.document, s.runId);
    expect(run.broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(run.pis).toEqual(runOf(s.doc, s.runId).pis);
  });

  it('moving the equipment through update_equipment_parameters is the same path: no pump, so the tie-in stands for it; check_piping stays clean of adverse slopes', () => {
    const moved = moveTie(s.doc, s.hub, [8500, 0, 0]);
    const check = data<{ issues: Array<{ code: string }> }>(moved.document, 'check_piping', {});
    expect(check.issues.filter((issue) => issue.code === 'RTE_ADVERSE_SLOPE' || issue.code === 'RTE_POCKET')).toEqual([]);
    expect(apply(moved.document, 'piping_takeoff', {})).toBe(moved.document);
  });
});

describe('the start moves with the pump (through update_equipment)', () => {
  it('pump +500 X toward the hub: plan 8000 -> 7500, drop 75, corner z exactly 925; cuts 7500 sqrt(1 + 0.01^2) - 79 - 152 and 925 - 152 = 773', () => {
    let doc = cs150Line(100, '6002').doc;
    doc = apply(doc, 'add_equipment', { name: 'Drain pump', mark: 'P-301', location: [0, -300], size: [1200, 600, 800], weight: 650 });
    doc = apply(doc, 'add_nozzle', {
      equipment: 'P-301',
      mark: 'N1',
      dn: 100,
      rating: 'CL150',
      facing: 'RF',
      location: { on: 'free', position: [0, 300, 1000], direction: [1, 0, 0] },
      projection: 300,
    });
    const hub = addTie(doc, 'TP-D2', [8000, 0, 0], [0, 0, 1], { dn: 100 });
    const routed = ok(hub.doc, 'route_pipe', {
      lineId: piping(hub.doc).lineOrder.at(-1),
      from: { portId: 'P-301:N1' },
      to: { portId: hub.id },
      legs: [{ direction: '+X', planLength: 8000, slope: SLOPE }],
    });
    const runId = (routed.data as { runId: string }).runId;
    const pump = Object.values(routed.document.building?.elements ?? {}).find((element) => element.category === 'equipment')?.id as string;
    const moved = ok(routed.document, 'update_equipment', { elementId: pump, location: [500, -300] });
    expect(moved.summary).toContain('orthogonal stretch');
    expect(runOf(moved.document, runId).pis).toEqual([[8000, 0, 925]]);
    expect(cuts(moved.document, runId)).toEqual([expect.closeTo(slopedLength(7500) - 79 - 152, 6), 773]);
    expect(runOf(moved.document, runId).broken).toBeUndefined();
  });
});
