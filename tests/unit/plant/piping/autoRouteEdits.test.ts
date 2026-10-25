/**
 * Plant 02 RTE V2: what happens to an auto-routed run when it is edited afterwards. The `autoRoute` record says the PIs are exactly the solution
 * the router committed and `checkSolution` accepted; a hand edit (`edit_route`) or a stretch (equipment moved) changes the PIs, so the record goes.
 * Inline components, supports and persistence do not touch the PIs and keep it.
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import type { PipeRun } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { pumpToVessel } from './rteFixtures';

const runOf = (doc: CadDocument, runId: string): PipeRun => doc.plant?.piping?.runs[runId] as PipeRun;

/** SC-RTE-01 scene (pump discharge up from z 1000, vessel inlet at z 4000) routed by `auto_route_pipe` on a 100 mm lattice. */
function autoRouted(): { doc: CadDocument; runId: string; lineId: string } {
  const withLine = apply(pumpToVessel(), 'create_pipeline', {
    service: 'P',
    sequence: '1001',
    spec: 'CS150',
    dn: 100,
    from: 'P-101:N2',
    to: 'V-101:N1',
    designTempC: 60,
    designPressureBarG: 10,
  });
  const lineId = withLine.plant?.piping?.lineOrder.at(-1) as string;
  const routed = ok(withLine, 'auto_route_pipe', { lineId, from: { portId: 'P-101:N2' }, to: { portId: 'V-101:N1' }, grid: 100 });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId, lineId };
}

describe('an auto-routed run after hand edits', () => {
  const s = autoRouted();

  it('starts with the record of the committed solution', () => {
    const record = runOf(s.doc, s.runId).autoRoute;
    expect(record).toMatchObject({ engine: 'ts', optimal: true });
    expect(record?.bends).toBe(runOf(s.doc, s.runId).pis.length);
  });

  it('edit_route drops the record: the PIs are no longer the router solution', () => {
    // The route is up 3000, +Y 3000, +X 6000; a jog up 500 over 2000 mm of the last leg.
    const jog = [
      [2000, 3000, 4000],
      [2000, 3000, 4500],
      [4000, 3000, 4500],
      [4000, 3000, 4000],
    ];
    const edited = ok(s.doc, 'edit_route', { runId: s.runId, op: 'insert_pi', index: 2, points: jog });
    expect(runOf(edited.document, s.runId).pis).toHaveLength(6);
    expect(runOf(edited.document, s.runId).autoRoute).toBeUndefined();
    expect(runOf(edited.document, s.runId).broken).toBeUndefined();
  });

  it('a stretch (the vessel moved) drops the record and keeps the run derived', () => {
    const moved = ok(s.doc, 'update_equipment_parameters', { equipment: 'V-101', set: { location: [7500, 3000] } });
    expect(moved.summary).toContain('re-routed 1 run(s) by orthogonal stretch');
    const run = runOf(moved.document, s.runId);
    expect(run.autoRoute).toBeUndefined();
    expect(run.broken).toBeUndefined();
    expect(run.end.point[0]).toBe(runOf(s.doc, s.runId).end.point[0] + 500);
    expect(moved.document.plant?.piping?.entityIds[s.runId]?.length).toBeGreaterThan(0);
  });

  it('a valve inserted in a leg keeps the record: the PIs are unchanged', () => {
    const inserted = ok(s.doc, 'insert_inline_component', { runId: s.runId, type: 'valveGate', at: { leg: 0, centreDistance: 600 } });
    expect(runOf(inserted.document, s.runId).autoRoute).toEqual(runOf(s.doc, s.runId).autoRoute);
    expect(runOf(inserted.document, s.runId).pis).toEqual(runOf(s.doc, s.runId).pis);
  });

  it('a save and load round trip keeps the record', () => {
    const loaded = deserializeDocument(serializeDocument(s.doc));
    expect(runOf(loaded, s.runId).autoRoute).toEqual(runOf(s.doc, s.runId).autoRoute);
  });

  it('convert_pipe_run does not take a plant run: it converts legacy pipes only, and the run is untouched', () => {
    const refusal = expectRefusal(s.doc, 'convert_pipe_run', { pipeId: s.runId, spec: 'CS150' }, 'RTE_UNKNOWN_PIPE');
    expect(refusal.document).toBe(s.doc);
  });

  it('deleting the run removes the record with it and frees the ports', () => {
    const gone = apply(s.doc, 'delete_pipe_run', { runId: s.runId });
    expect(gone.plant?.piping?.runs[s.runId]).toBeUndefined();
    expect(
      data(gone, 'route_problem', { lineId: s.lineId, from: { portId: 'P-101:N2' }, to: { portId: 'V-101:N1' }, grid: 100 }),
    ).toBeDefined();
  });
});
