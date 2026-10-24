/**
 * Orthogonal stretch (02 RTE §5.7, M3): a run follows the port it is connected to when equipment or a tie-in moves; the displacement is absorbed by
 * the legs parallel to it, walking back from the moved end. SC-RTE-06 numbers are hand calculations of the validation pack.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { walkChain, walkWithInjection } from '@aec/plant/piping/stretchWalk';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, routedPumpToVessel, routedPumpToVesselWithTee } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const runOf = (doc: CadDocument, runId: string): PipeRun => piping(doc).runs[runId] as PipeRun;
const cuts = (doc: CadDocument, runId: string): number[] =>
  data<{ pipePieces: Array<{ cutLengthMm: number }> }>(doc, 'piping_takeoff', { runId }).pipePieces.map((piece) => piece.cutLengthMm);
const equipmentId = (doc: CadDocument, mark: string): string =>
  Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === mark)?.id as string;

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

describe('SC-RTE-06: move the vessel, the run follows (hand calculation of the pack)', () => {
  const s = routedPumpToVessel();

  it('+500 X is absorbed by the last leg (+X): cut 3000 + 500 - 152 - 76 - 3 = 3269, the other pieces are unchanged', () => {
    const moved = ok(s.doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7500, 3000] } });
    expect(moved.summary).toContain('re-routed 1 run(s) by orthogonal stretch');
    expect(moved.summary).toContain('end moved 500, 0, 0');
    expect(cuts(moved.document, s.runId)).toEqual([1269, 2696, 2696, 1196, 3269]);
    const run = runOf(moved.document, s.runId);
    expect(run.end.point).toEqual([6500, 3000, 4000]);
    expect(run.pis).toEqual(runOf(s.doc, s.runId).pis);
    expect(run.broken).toBeUndefined();
  });

  it('then +500 Y crosses the +X and +Z legs (their PIs move +500 Y) and is absorbed by the +Y leg: 3500 - 2 x 152 = 3196', () => {
    const first = apply(s.doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7500, 3000] } });
    const second = apply(first, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7500, 3500] } });
    expect(cuts(second, s.runId)).toEqual([1269, 3196, 2696, 1196, 3269]);
    expect(runOf(second, s.runId).pis).toEqual([
      [0, 0, 2500],
      [0, 3500, 2500],
      [3000, 3500, 2500],
      [3000, 3500, 4000],
    ]);
    expect(data<{ counts: Record<string, number> }>(second, 'piping_takeoff', { runId: s.runId }).counts['elbow90LR']).toBe(4);
  });

  it('the stretched model equals what a load re-derives (live = load) and moving back restores the original run', () => {
    const moved = apply(s.doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7500, 3500] } });
    const loaded = deserializeDocument(serializeDocument(moved));
    expect(loaded.plant).toEqual(moved.plant);
    for (const id of piping(moved).entityIds[s.runId] as string[]) expect(loaded.entities[id]).toEqual(moved.entities[id]);
    const back = apply(moved, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7000, 3000] } });
    expect(runOf(back, s.runId).pis).toEqual(runOf(s.doc, s.runId).pis);
    expect(cuts(back, s.runId)).toEqual([1269, 2696, 2696, 1196, 2769]);
  });

  it('moving the pump (the start) +300 X is absorbed by the +X leg too, +300 Y by the +Y leg; the start stays on its nozzle', () => {
    const pump = equipmentId(s.doc, 'P-101');
    const x = apply(s.doc, 'update_equipment', { elementId: pump, location: [300, -300] });
    expect(cuts(x, s.runId)).toEqual([1269, 2696, 2396, 1196, 2769]);
    expect(runOf(x, s.runId).start.point).toEqual([300, 0, 1000]);
    const y = apply(s.doc, 'update_equipment', { elementId: pump, location: [0, 0] });
    expect(cuts(y, s.runId)).toEqual([1269, 2396, 2696, 1196, 2769]);
  });

  it('a move that is not absorbed breaks the run: RTE_STRETCH_FAILED names the leg, the stored run is kept as routed', () => {
    const moved = ok(s.doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [3000, 3000] } });
    const run = runOf(moved.document, s.runId);
    expect(run.broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(run.broken?.reason).toContain('leg 4');
    expect(run.pis).toEqual(runOf(s.doc, s.runId).pis);
    expect(piping(moved.document).entityIds[s.runId]).toEqual([]);
    expect(moved.summary).toContain('now broken');
  });
});

describe('stretch of open ends, both ends, components and branches', () => {
  /** Tie A (0,0,0) +X, tie B (4000,3000,0) facing -X; legs +X 2000, +Y 3000, closing +X 2000. */
  function zRun(): { doc: CadDocument; runId: string; a: string; b: string } {
    const line = cs150Line();
    const a = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0]);
    const b = addTie(a.doc, 'B', [4000, 3000, 0], [-1, 0, 0]);
    const doc = apply(b.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      to: { portId: b.id },
      legs: [
        { direction: '+X', length: 2000 },
        { direction: '+Y', length: 3000 },
      ],
    });
    return { doc, runId: piping(doc).runOrder[0] as string, a: a.id, b: b.id };
  }

  it('the start tie-in moving along its leg shortens it (cut 1848 - 500); the run keeps its PIs', () => {
    const z = zRun();
    const moved = moveTie(z.doc, z.a, [500, 0, 0]);
    expect(cuts(moved.document, z.runId)).toEqual([1348, 2696, 1848]);
    expect(moved.notes[0]).toContain('start moved 500, 0, 0');
    expect(runOf(moved.document, z.runId).pis).toEqual(runOf(z.doc, z.runId).pis);
  });

  it('both ends moving: the start forward walk then the end walk back (start +500 X, end +200 Y)', () => {
    const z = zRun();
    const first = moveTie(z.doc, z.a, [500, 0, 0]);
    const second = moveTie(first.document, z.b, [4000, 3200, 0]);
    expect(cuts(second.document, z.runId)).toEqual([1348, 2896, 1848]);
    // Both at once, in one reconcile.
    const model = piping(z.doc);
    const tieA = model.tieIns[z.a] as NonNullable<(typeof model.tieIns)[string]>;
    const tieB = model.tieIns[z.b] as NonNullable<(typeof model.tieIns)[string]>;
    const both: CadDocument = {
      ...z.doc,
      plant: {
        ...z.doc.plant,
        piping: {
          ...model,
          tieIns: {
            [z.a]: { ...tieA, port: { ...tieA.port, position: [500, 0, 0] } },
            [z.b]: { ...tieB, port: { ...tieB.port, position: [4000, 3200, 0] } },
          },
        },
      },
    };
    expect(cuts(pipingDocument.reconcile?.(z.doc, both).document as CadDocument, z.runId)).toEqual([1348, 2896, 1848]);
  });

  it('a displacement no leg is parallel to (z with only X and Y legs) breaks the run and says what is left over', () => {
    const z = zRun();
    const moved = moveTie(z.doc, z.b, [4000, 3000, 100]);
    const run = runOf(moved.document, z.runId);
    expect(run.broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(run.broken?.reason).toContain('remainder of 0, 0, 100');
    expect(run.pis).toEqual(runOf(z.doc, z.runId).pis);
  });

  it('an open end stays where the legs absorb the move, and follows (is carried) where they cannot', () => {
    const line = cs150Line();
    const a = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0]);
    const doc = apply(a.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      legs: [
        { direction: '+X', length: 2000 },
        { direction: '+Y', length: 2000 },
      ],
    });
    const runId = piping(doc).runOrder[0] as string;
    const absorbed = moveTie(doc, a.id, [0, 300, 0]);
    expect(runOf(absorbed.document, runId).end.point).toEqual([2000, 2000, 0]);
    expect(runOf(absorbed.document, runId).pis).toEqual([[2000, 300, 0]]);
    expect(cuts(absorbed.document, runId)).toEqual([1848, 1548]);
    const lifted = moveTie(doc, a.id, [0, 0, 300]);
    expect(runOf(lifted.document, runId).end.point).toEqual([2000, 2000, 300]);
    expect(runOf(lifted.document, runId).pis).toEqual([[2000, 0, 300]]);
    expect(cuts(lifted.document, runId)).toEqual([1848, 1848]);
  });

  it('a valve keeps its position along the leg axis: the start moving +100 along the leg shortens it, the valve sits 100 closer', () => {
    const z = zRun();
    const valved = apply(z.doc, 'insert_inline_component', { runId: z.runId, type: 'valveGate', at: { leg: 0, centreDistance: 1000 } });
    const moved = moveTie(valved, z.a, [100, 0, 0]);
    const valve = runOf(moved.document, z.runId).inline?.[0];
    expect(valve).toMatchObject({ leg: 0, centreDistance: 900 });
    const centre = data<{ inline: Array<{ centre: number[] }> }>(moved.document, 'piping_takeoff', { runId: z.runId }).inline[0]?.centre;
    expect(centre).toEqual([1000, 0, 0]);
  });

  it('a valve the shortened leg would swallow breaks the run (RTE_STRETCH_FAILED names the valve)', () => {
    const z = zRun();
    const valved = apply(z.doc, 'insert_inline_component', { runId: z.runId, type: 'valveGate', at: { leg: 0, centreDistance: 600 } });
    const moved = moveTie(valved, z.a, [900, 0, 0]);
    const run = runOf(moved.document, z.runId);
    expect(run.broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(run.broken?.reason).toContain('valveGate');
  });

  it('a branch follows its header: the pump moving +300 X moves the branch point, and the branch (open end fixed) shortens', () => {
    const s = routedPumpToVesselWithTee();
    const before = cuts(s.doc, s.branchRunId);
    const pump = equipmentId(s.doc, 'P-101');
    const moved = apply(s.doc, 'update_equipment', { elementId: pump, location: [300, -300] });
    expect(runOf(moved, s.branchRunId).start.point).toEqual([300, 1500, 2500]);
    expect(runOf(moved, s.branchRunId).broken).toBeUndefined();
    expect(cuts(moved, s.branchRunId)).toEqual([(before[0] as number) - 300]);
    expect(runOf(moved, s.runId).branches?.[0]).toMatchObject({ leg: 1, distance: 1500 });
  });
});

describe('the walk (pure)', () => {
  const x: [number, number, number] = [1, 0, 0];
  const y: [number, number, number] = [0, 1, 0];
  const z: [number, number, number] = [0, 0, 1];

  it('absorbs a move along a leg and carries the rest perpendicular to the previous point', () => {
    const walked = walkChain([z, y, x, z, x], [0, 0, 0], [0, 500, 0], 1e-6);
    expect(walked).toMatchObject({ ok: true });
    if (walked.ok)
      expect(walked.displacements).toEqual([
        [0, 0, 0],
        [0, 0, 0],
        [0, 500, 0],
        [0, 500, 0],
        [0, 500, 0],
        [0, 500, 0],
      ]);
  });

  it('fails with the remainder at the pinned start when no leg is parallel', () => {
    const walked = walkChain([x, y], [0, 0, 0], [0, 0, 7], 1e-6);
    expect(walked).toEqual({ ok: false, at: 'first', remainder: [0, 0, 7] });
  });

  it('a free start follows; two free ends do not move', () => {
    const free = walkChain([x, y], null, [0, 0, 7], 1e-6);
    expect(free).toMatchObject({ ok: true });
    expect(walkChain([x, y], null, null, 1e-6)).toEqual({
      ok: true,
      displacements: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
  });

  it('an injected point splits the chain: each side is walked on its own', () => {
    const walked = walkWithInjection([x, y, x], 1, [100, 0, 0], [0, 0, 0], [0, 0, 0], 1e-6);
    expect(walked).toMatchObject({ ok: true });
    if (walked.ok)
      expect(walked.displacements).toEqual([
        [0, 0, 0],
        [100, 0, 0],
        [100, 0, 0],
        [0, 0, 0],
      ]);
    const refused = walkWithInjection([x, y], 1, [0, 0, 5], [0, 0, 0], [0, 0, 0], 1e-6);
    expect(refused).toMatchObject({ ok: false, side: 'before' });
  });
});
