/**
 * Derived pipe entities always equal what a load re-derives (architecture L8): after a spec / catalogue, line, tie-in or equipment-nozzle edit
 * the piping extension's `reconcile` re-derives the affected runs; a run that no longer derives is marked broken and drawn no more.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument, RevolutionEntity } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { pipingDocument } from '@aec/plant/piping/derive';
import { apply, data, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, rteJson, routedPumpToVessel } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;
const equipmentId = (doc: CadDocument, mark: string): string =>
  Object.values(doc.building?.elements ?? {}).find((element) => element.category === 'equipment' && element.mark === mark)?.id as string;

interface Takeoff {
  runs: string[];
  brokenRuns: Array<{ runId: string; code: string; message: string }>;
  pipePieces: Array<{ cutLengthMm: number }>;
}

describe('reconcile after an equipment / nozzle edit', () => {
  const s = routedPumpToVessel();
  const parts = piping(s.doc).entityIds[s.runId] as string[];

  it('a nozzle that no longer matches the run (rating) breaks the run: parts removed, reason on the run, reported in the summary', () => {
    const result = ok(s.doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', rating: 'CL300' });
    const run = piping(result.document).runs[s.runId] as PipeRun;
    expect(run.broken?.code).toBe('RTE_RATING_MISMATCH');
    expect(piping(result.document).entityIds[s.runId]).toEqual([]);
    for (const id of parts) {
      expect(result.document.entities[id]).toBeUndefined();
      expect(result.document.order).not.toContain(id);
    }
    expect(result.summary).toContain(`piping: re-derived 1 run(s); now broken, parts removed: ${s.runId} (RTE_RATING_MISMATCH`);
    // The stored intent is untouched.
    expect(run.pis).toEqual((piping(s.doc).runs[s.runId] as PipeRun).pis);
  });

  it('a resized nozzle breaks the run with RTE_SIZE_MISMATCH; restoring it re-derives the identical entities and clears the mark', () => {
    const resized = apply(s.doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', dn: 150 });
    expect((piping(resized).runs[s.runId] as PipeRun).broken?.code).toBe('RTE_SIZE_MISMATCH');
    const back = ok(resized, 'update_nozzle', { equipment: 'V-101', mark: 'N1', dn: 100 });
    expect((piping(back.document).runs[s.runId] as PipeRun).broken).toBeUndefined();
    expect(piping(back.document).entityIds[s.runId]).toEqual(parts);
    for (const id of parts) expect(back.document.entities[id]).toEqual(s.doc.entities[id]);
    expect(back.summary).toContain('piping: re-derived 1 run(s).');
  });

  it('moving the equipment moves the port away from the routed end: RTE_STRETCH_FAILED (stretch is 02 M3), moving back repairs it', () => {
    const vessel = equipmentId(s.doc, 'P-101');
    const moved = ok(s.doc, 'update_equipment', { elementId: vessel, location: [100, -300] });
    const broken = (piping(moved.document).runs[s.runId] as PipeRun).broken;
    expect(broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(broken?.reason).toContain('P-101:N2');
    expect(moved.summary).toContain('RTE_STRETCH_FAILED');
    const back = apply(moved.document, 'update_equipment', { elementId: vessel, location: [0, -300] });
    expect((piping(back).runs[s.runId] as PipeRun).broken).toBeUndefined();
    expect(piping(back).entityIds[s.runId]).toEqual(parts);
  });

  it('removing the equipment leaves the run broken with RTE_UNKNOWN_PORT', () => {
    const removed = apply(s.doc, 'delete_building_element', { elementIds: [equipmentId(s.doc, 'P-101')] });
    expect((piping(removed).runs[s.runId] as PipeRun).broken?.code).toBe('RTE_UNKNOWN_PORT');
    expect(piping(removed).entityIds[s.runId]).toEqual([]);
  });

  it('a load shows the same state: the broken mark is restored and piping_takeoff lists the run, skipping it in the totals', () => {
    const resized = apply(s.doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', dn: 150 });
    const loaded = deserializeDocument(serializeDocument(resized));
    expect(loaded.plant).toEqual(resized.plant);
    const whole = data<Takeoff>(loaded, 'piping_takeoff', {});
    expect(whole.runs).toEqual([]);
    expect(whole.brokenRuns).toEqual([{ runId: s.runId, code: 'RTE_SIZE_MISMATCH', message: expect.stringContaining('DN150') }]);
    const refused = execute(loaded, 'piping_takeoff', { runId: s.runId });
    expect(refused.error?.code).toBe('RTE_SIZE_MISMATCH');
  });

  it('commands that do not touch plant data leave the document alone (no re-derivation, same plant object)', () => {
    const result = ok(s.doc, 'add_box', { size: [1, 1, 1] });
    expect(result.document.plant).toBe(s.doc.plant);
    expect(result.summary).not.toContain('piping:');
  });
});

describe('reconcile after a spec, catalogue, line or tie-in edit', () => {
  it('a catalogue dimension change re-derives the entities (same ids, new geometry) without refusing', () => {
    const s = routedPumpToVessel();
    const catalog = rteJson<{ families: Array<{ type: string; sizes: Array<Record<string, unknown>> }> }>('catalog_stub_cs150.json');
    for (const family of catalog.families) {
      if (family.type !== 'elbow90') continue;
      for (const size of family.sizes) if (size['nps'] === 4) size['centreToEnd'] = 150;
    }
    const edited = ok(s.doc, 'import_piping_catalog', { catalog, replace: true });
    const piece = `${s.runId}/pipe-1`;
    const entity = edited.document.entities[piece] as RevolutionEntity;
    // 1500 - (3 + 76) - 150: the cut grew by the 2 mm the elbow lost.
    expect(entity.profile[2]?.[1]).toBeCloseTo(1271, 9);
    expect(piping(edited.document).entityIds[s.runId]).toEqual(piping(s.doc).entityIds[s.runId]);
    expect(edited.summary).toContain('piping: re-derived 1 run(s).');
    const takeoff = data<Takeoff>(edited.document, 'piping_takeoff', {});
    expect(takeoff.pipePieces[0]?.cutLengthMm).toBe(1271);
    const loaded = deserializeDocument(serializeDocument(edited.document));
    expect(loaded.entities[piece]).toEqual(edited.document.entities[piece]);
  });

  it('a harmless spec edit re-derives identical entities; a refused one changes nothing', () => {
    const s = routedPumpToVessel();
    const retitled = apply(s.doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'setHeader', fields: { title: 'x' } }] });
    for (const id of piping(s.doc).entityIds[s.runId] as string[]) expect(retitled.entities[id]).toEqual(s.doc.entities[id]);
    const refused = execute(s.doc, 'edit_pipe_spec', { specId: 'CS150', ops: [{ op: 'removeComponent', id: 'E90-LR' }] });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(s.doc);
  });

  it('a changed line (DN) and a replaced tie-in are noticed by reconcile', () => {
    const { doc: withLine, lineId } = cs150Line();
    const a = addTie(withLine, 'A', [0, 0, 0], [1, 0, 0]);
    const routed = apply(a.doc, 'route_pipe', { lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 2000 }] });
    const runId = piping(routed).runOrder[0] as string;
    const model = piping(routed);
    const tie = model.tieIns[a.id] as NonNullable<(typeof model.tieIns)[string]>;
    const movedTie: CadDocument = {
      ...routed,
      plant: {
        ...routed.plant,
        piping: { ...model, tieIns: { ...model.tieIns, [a.id]: { ...tie, port: { ...tie.port, position: [10, 0, 0] } } } },
      },
    };
    const tieResult = pipingDocument.reconcile?.(routed, movedTie);
    const tieRun = tieResult === undefined ? undefined : piping(tieResult.document).runs[runId];
    expect(tieRun?.broken?.code).toBe('RTE_STRETCH_FAILED');
    expect(tieResult?.notes[0]).toContain(runId);
    const resizedLine: CadDocument = {
      ...routed,
      plant: {
        ...routed.plant,
        piping: {
          ...model,
          lines: { ...model.lines, [lineId]: { ...(model.lines[lineId] as NonNullable<(typeof model.lines)[string]>), dn: 150 } },
        },
      },
    };
    const lineResult = pipingDocument.reconcile?.(routed, resizedLine);
    expect(lineResult === undefined ? undefined : piping(lineResult.document).runs[runId]?.broken?.code).toBe('RTE_SIZE_MISMATCH');
  });

  it('does nothing without runs, and ignores runs a command created itself', () => {
    const { doc } = cs150Line();
    expect(pipingDocument.reconcile?.(doc, doc)).toEqual({ document: doc, notes: [] });
    const s = routedPumpToVessel();
    expect(pipingDocument.reconcile?.(s.doc, s.doc)?.notes).toEqual([]);
  });
});

describe('property provider of part entities', () => {
  it('finds the owning run through entityIds, names the part kind, and gives the pipe OD to pipe pieces and elbows only', async () => {
    const { plantEntityProperties } = await import('@aec/plant/display/properties');
    const s = routedPumpToVessel();
    const run = s.runId;
    expect(plantEntityProperties(s.doc, `${run}/pipe-1`)).toMatchObject({
      category: 'pipe',
      partKind: 'pipe',
      odMm: 114.3,
      dn: 100,
      spec: 'CS150',
    });
    expect(plantEntityProperties(s.doc, `${run}/elbow-1`)).toMatchObject({ partKind: 'elbow', odMm: 114.3 });
    const flange = plantEntityProperties(s.doc, `${run}/flange-1`);
    expect(flange).toMatchObject({ partKind: 'flange', line: '100-P-1001-CS150' });
    expect(flange).not.toHaveProperty('odMm');
    // An id with a run prefix that the run does not list is not its part.
    expect(plantEntityProperties(s.doc, `${run}/pipe-99`)).toEqual({});
  });
});
