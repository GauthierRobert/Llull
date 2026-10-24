/** Plant 02 RTE M2: `update_pipeline` changes a line and re-derives its runs; a spec that cannot build the runs is refused whole. */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Line, headerScene, rteJson, routedPumpToVessel } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Updated {
  lineId: string;
  lineNumber: string;
  changed: string[];
  specChanged: boolean;
  rederivedRuns: string[];
  unverified: boolean;
}

/** `doc` with a second spec derived from CS150 (id `id`); `components` filters its components. */
function withSpec(doc: CadDocument, id: string, patch: Record<string, unknown> = {}): CadDocument {
  return apply(doc, 'import_pipe_spec', { spec: { ...rteJson('spec_cs150.json'), id, ...patch } });
}

describe('update_pipeline on a line without runs', () => {
  const s = cs150Line();

  it('a line number that followed the template follows it after a sequence change: 100-P-1001-CS150 -> 100-P-1002-CS150', () => {
    const result = data<Updated>(s.doc, 'update_pipeline', { lineId: s.lineId, sequence: '1002' });
    expect(result.lineNumber).toBe('100-P-1002-CS150');
    expect(result.changed).toEqual(['lineNumber', 'sequence']);
    expect(result.rederivedRuns).toEqual([]);
    expect(piping(apply(s.doc, 'update_pipeline', { lineId: s.lineId, sequence: '1002' })).lines[s.lineId]?.sequence).toBe('1002');
  });

  it('an explicit line number is kept by other changes and replaced by lineNumber', () => {
    const explicit = apply(s.doc, 'update_pipeline', { lineId: s.lineId, lineNumber: 'X-1' });
    expect(piping(apply(explicit, 'update_pipeline', { lineId: s.lineId, service: 'CW' })).lines[s.lineId]?.lineNumber).toBe('X-1');
    expect(piping(apply(explicit, 'update_pipeline', { lineId: s.lineId, lineNumber: 'X-2' })).lines[s.lineId]?.lineNumber).toBe('X-2');
  });

  it('insulation adds its suffix to a template number (-H50) and null removes it; from / to set and clear; design conditions are stored', () => {
    const insulated = apply(s.doc, 'update_pipeline', {
      lineId: s.lineId,
      insulation: { code: 'H', thickness: 50 },
      from: 'E-1',
      to: 'E-2',
      designPressureBarG: 10,
      designTempC: 180,
    });
    expect(piping(insulated).lines[s.lineId]).toMatchObject({
      lineNumber: '100-P-1001-CS150-H50',
      insulation: { code: 'H', thicknessMm: 50, source: 'explicit' },
      from: 'E-1',
      to: 'E-2',
      designPressureBarG: 10,
      designTempC: 180,
    });
    const cleared = apply(insulated, 'update_pipeline', { lineId: s.lineId, insulation: null, from: '', to: '' });
    const line = piping(cleared).lines[s.lineId];
    expect(line?.lineNumber).toBe('100-P-1001-CS150');
    expect(line?.insulation).toBeUndefined();
    expect(line?.from).toBeUndefined();
    expect(line?.to).toBeUndefined();
  });

  it('a change that sets nothing new is a no-op (not a refusal)', () => {
    const result = ok(s.doc, 'update_pipeline', { lineId: s.lineId, sequence: '1001' });
    expect(result.document).toBe(s.doc);
    expect(result.rejected).toBeUndefined();
    expect(result.summary).toContain('no-op');
  });

  it('is pure', () => {
    const before = structuredClone(s.doc);
    ok(s.doc, 'update_pipeline', { lineId: s.lineId, sequence: '7' });
    expect(s.doc).toEqual(before);
  });

  it.each([
    ['an unknown line', { lineId: 'line-nope', sequence: '1' }, 'RTE_UNKNOWN_LINE', 'lineId'],
    ['an unknown spec', { lineId: s.lineId, spec: 'NOPE' }, 'RTE_SPEC_UNKNOWN', 'spec'],
  ])('refuses %s', (_name, params, code, path) => {
    expectRefusal(s.doc, 'update_pipeline', params, code, path);
  });

  it('refuses a line number another line uses', () => {
    const two = apply(s.doc, 'create_pipeline', { service: 'P', sequence: '2', spec: 'CS150', dn: 100 });
    const other = piping(two).lineOrder[1] as string;
    expectRefusal(two, 'update_pipeline', { lineId: other, lineNumber: '100-P-1001-CS150' }, 'RTE_DUPLICATE_LINE_NUMBER', 'lineNumber');
  });
});

describe('update_pipeline re-derives the runs of the line', () => {
  const s = routedPumpToVessel();

  it('a new spec re-selects the parts and keeps the cut lengths when the dimensions are the same (CS150B is a copy of CS150)', () => {
    const doc = withSpec(s.doc, 'CS150B');
    const result = ok(doc, 'update_pipeline', { lineId: s.line, spec: 'CS150B' });
    const info = result.data as Updated;
    expect(info).toMatchObject({ specChanged: true, rederivedRuns: [s.runId], lineNumber: '100-P-1001-CS150B' });
    expect(result.affected.slice(0, 2)).toEqual([s.line, s.runId]);
    expect(piping(result.document).lines[s.line]?.spec).toBe('CS150B');
    const cuts = data<{ pipePieces: Array<{ cutLengthMm: number; catalogueKey: string }> }>(result.document, 'piping_takeoff', {
      runId: s.runId,
    }).pipePieces;
    expect(cuts.map((piece) => piece.cutLengthMm)).toEqual([1269, 2696, 2696, 1196, 2769]);
    expect(cuts[0]?.catalogueKey).toBe('CS150B/P-BW/100');
    expect(result.summary).toContain('spec CS150 -> CS150B');
  });

  it('a new spec that cannot build the run (no elbows) is refused whole: RTE_SPEC_NO_COMPONENT, nothing changes', () => {
    const spec = rteJson<{ components: Array<{ type: string }> }>('spec_cs150.json');
    const doc = withSpec(s.doc, 'CS150X', { components: spec.components.filter((component) => !component.type.startsWith('elbow')) });
    const refused = expectRefusal(doc, 'update_pipeline', { lineId: s.line, spec: 'CS150X' }, 'RTE_SPEC_NO_COMPONENT');
    expect(refused.error?.ids).toContain(s.runId);
  });

  it('a new spec without a pipe row for the line size is refused (RTE_SPEC_NO_COMPONENT on spec)', () => {
    const doc = withSpec(s.doc, 'CS150S', { sizeRange: { fromNps: 2, toNps: 3 } });
    expectRefusal(doc, 'update_pipeline', { lineId: s.line, spec: 'CS150S' }, 'RTE_SPEC_NO_COMPONENT', 'spec');
  });

  it('changing only text re-derives the run too (the entities are rebuilt identically)', () => {
    const result = ok(s.doc, 'update_pipeline', { lineId: s.line, service: 'CW' });
    for (const id of piping(s.doc).entityIds[s.runId] ?? []) expect(result.document.entities[id]).toBeDefined();
    expect((result.data as Updated).rederivedRuns).toEqual([s.runId]);
  });
});

describe('update_pipeline on a line with a branch', () => {
  it('re-derives the header and the branch run together (a spec copy keeps the cuts 3857 / 5857 / 1870)', () => {
    const h = headerScene();
    const branched = apply(h.doc, 'add_branch', { runId: h.headerId, at: { point: [4000, 0, 3000] }, dn: 100, to: { portId: h.tieC } });
    const branchRun = piping(branched).runOrder.at(-1) as string;
    const result = ok(withSpec(branched, 'CS150B'), 'update_pipeline', { lineId: h.lineId, spec: 'CS150B' });
    expect((result.data as Updated).rederivedRuns).toEqual([h.headerId, branchRun]);
    const pieces = data<{ pipePieces: Array<{ cutLengthMm: number }> }>(result.document, 'piping_takeoff', { lineId: h.lineId }).pipePieces;
    expect(pieces.map((piece) => piece.cutLengthMm)).toEqual([3857, 5857, 1870]);
  });
});
