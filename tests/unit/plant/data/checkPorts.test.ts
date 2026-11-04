/**
 * Plant 08 DAT follow-up: the port rules of `check_plant_data`. DAT_OPEN_PORT (a line end that names nothing and is attached to nothing) and
 * DAT_INFERRED_NOZZLE (a nozzle only inferred from a line end, the equipment having no 03 EQP nozzle).
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { getPlantData } from '@aec/plant/data/model';
import { apply, data } from '../../../helpers/commandAssertions';
import { routedPumpToVessel } from '../piping/rteFixtures';
import { addEquipment, addPipe, assignPump, libraryDocument } from './dataFixtures';

interface Finding {
  code: string;
  severity: string;
  ids: string[];
  paths: string[];
  message: string;
}
const findingsOf = (doc: CadDocument, code: string, params: Record<string, unknown> = {}): Finding[] =>
  data<{ findings: Finding[] }>(doc, 'check_plant_data', params).findings.filter((finding) => finding.code === code);

/** Pump P-101 and a line from it to `to` (drawn pipe), the line classified as 50-CWS-0007-B2. */
function drawnLine(to: string, from = 'P-101'): { doc: CadDocument; line: string; pump: string } {
  const pump = addEquipment(libraryDocument());
  const tagged = assignPump(pump.doc, pump.id);
  const pipe = addPipe(tagged.doc, { line: 'L-1', from, to, service: 'cw' });
  const doc = apply(pipe.doc, 'assign_plant_object', {
    target: pipe.id,
    className: 'ProcessLine',
    hierarchy: 'U10',
    tagFields: { nominalSize: 50, fluidCode: 'CWS', seq: 7, spec: 'B2' },
  });
  return { doc, line: getPlantData(doc).objectOrder.at(-1) as string, pump: pump.id };
}

describe('DAT_OPEN_PORT', () => {
  it('warns for a drawn line end that names nothing, with the line path and ids; a named end or battery limit is not open', () => {
    const open = drawnLine('');
    const found = findingsOf(open.doc, 'DAT_OPEN_PORT');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warn', paths: ['50-CWS-0007-B2.to'], ids: [open.line, expect.any(String)] });
    expect(found[0]?.message).toContain('open');
    expect(findingsOf(open.doc, 'DAT_LINE_END_UNRESOLVED')).toEqual([]);
    expect(findingsOf(drawnLine('BL-1').doc, 'DAT_OPEN_PORT')).toEqual([]);
    expect(findingsOf(drawnLine('P-101').doc, 'DAT_OPEN_PORT')).toEqual([]);
    const both = findingsOf(drawnLine('', '').doc, 'DAT_OPEN_PORT');
    expect(both.map((finding) => finding.paths[0])).toEqual(['50-CWS-0007-B2.from', '50-CWS-0007-B2.to']);
  });

  it('a routed run end attached to a nozzle is not open; a detached end that names nothing is', () => {
    const scene = routedPumpToVessel();
    const doc = apply(scene.doc, 'define_plant_hierarchy', {
      nodes: [
        { code: 'S1', kind: 'site' },
        { code: 'U10', kind: 'unit', parent: 'S1', properties: { areaNumber: '1' } },
      ],
    });
    const library = apply(doc, 'load_plant_class_library', { library: 'llull-default-process' });
    const assigned = apply(library, 'assign_plant_object', {
      target: scene.line,
      className: 'ProcessLine',
      hierarchy: 'U10',
      properties: { fluidCode: 'P', spec: 'CS150' },
    });
    expect(findingsOf(assigned, 'DAT_OPEN_PORT')).toEqual([]);
    const piping = assigned.plant?.piping;
    const run = piping?.runs[scene.runId];
    expect(run).toBeDefined();
    if (piping === undefined || run === undefined) return;
    const { ref: _ref, ...end } = run.end;
    const detached: CadDocument = {
      ...assigned,
      plant: { ...assigned.plant, piping: { ...piping, runs: { ...piping.runs, [scene.runId]: { ...run, end } } } },
    };
    const unnamed = apply(detached, 'update_pipeline', { lineId: scene.line, to: '' });
    expect(findingsOf(unnamed, 'DAT_OPEN_PORT').map((finding) => finding.paths[0])).toEqual(['100-P-1001-CS150.to']);
    const attached = apply(assigned, 'update_pipeline', { lineId: scene.line, to: '' });
    expect(findingsOf(attached, 'DAT_OPEN_PORT')).toEqual([]);
    expect(findingsOf(attached, 'DAT_LINE_END_UNRESOLVED')).toHaveLength(1);
  });
});

describe('DAT_INFERRED_NOZZLE', () => {
  it('is an info finding per nozzle inferred from a line end, naming the equipment, the line and the nozzle path', () => {
    const scene = drawnLine('BL-1');
    const found = findingsOf(scene.doc, 'DAT_INFERRED_NOZZLE');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'info', paths: ['P-101/N1'], ids: [scene.pump, scene.line] });
    expect(found[0]?.message).toContain('from end of line 50-CWS-0007-B2');
    expect(data<{ status: string }>(scene.doc, 'check_plant_data', {}).status).toBe('pass');
  });

  it('is not raised for equipment with real nozzles, and follows the object scope', () => {
    const scene = routedPumpToVessel();
    expect(findingsOf(scene.doc, 'DAT_INFERRED_NOZZLE')).toEqual([]);
    const drawn = drawnLine('BL-1');
    expect(findingsOf(drawn.doc, 'DAT_INFERRED_NOZZLE', { classes: ['ProcessLine'] })).toHaveLength(1);
    expect(findingsOf(drawn.doc, 'DAT_INFERRED_NOZZLE', { classes: ['Tank'] })).toEqual([]);
  });

  it('is pure', () => {
    const scene = drawnLine('BL-1');
    const before = structuredClone(scene.doc);
    expect(execute(scene.doc, 'check_plant_data', {}).document).toBe(scene.doc);
    expect(scene.doc).toEqual(before);
  });
});
