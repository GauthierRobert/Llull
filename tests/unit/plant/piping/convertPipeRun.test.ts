/**
 * Plant 02 RTE M2: `convert_pipe_run` (SC-RTE-09, VC-RTE-20): a legacy building pipe (add_pipe_run polyline) becomes a spec-driven run. Expected cut
 * lengths are hand calculations with the NPS 4 LR elbow A = 152 from the catalogue stub (open ends, so no end deduction).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { cs150Document } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Converted {
  runId: string;
  lineId: string;
  lineNumber: string;
  lineCreated: boolean;
  dn: number;
  dnSource: string;
  pis: number[][];
  counts: Record<string, number>;
  pipePieces: Array<{ cutLengthMm: number }>;
  totalPipeMm: number;
  replaced: boolean;
}

const SC09 = [
  [1000, 3000, 1500],
  [5000, 3000, 1500],
  [5000, 6000, 1500],
  [5000, 6000, 4000],
];

/** The CS150 document with a legacy pipe through `points`; returns the document and the pipe's element id (affected[0]). */
function legacy(
  points: number[][] = SC09,
  extra: Record<string, unknown> = { dn: 100, line: 'L-1', service: 'cooling water' },
): { doc: CadDocument; pipeId: string } {
  const result = ok(cs150Document(), 'add_pipe_run', { points, ...extra });
  return { doc: result.document, pipeId: result.affected[0] as string };
}

describe('convert_pipe_run (SC-RTE-09)', () => {
  const s = legacy();

  it('turns the polyline into a run: 2 elbows, cuts 3848 / 2696 / 2348, 4 butt welds, line number L-1 kept verbatim', () => {
    // legs 4000 (+X), 3000 (+Y), 2500 (+Z): 4000 - 152 ; 3000 - 2 x 152 ; 2500 - 152
    const result = data<Converted>(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' });
    expect(result.lineNumber).toBe('L-1');
    expect(result.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([3848, 2696, 2348]);
    expect(result.counts).toMatchObject({ elbow90LR: 2, pipePieces: 3, buttWelds: 4 });
    expect(result.totalPipeMm).toBe(8892);
    expect(result.pis).toEqual([
      [5000, 3000, 1500],
      [5000, 6000, 1500],
    ]);
    expect(result).toMatchObject({ dn: 100, lineCreated: true, replaced: false });
  });

  it('creates the line (service, sequence, spec, size) and stores a run with two open ends; check_piping lists exactly two open ends', () => {
    const next = apply(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' });
    const model = piping(next);
    const line = model.lines[model.lineOrder[0] as string];
    expect(line).toMatchObject({ lineNumber: 'L-1', service: 'cooling water', sequence: 'L-1', spec: 'CS150', dn: 100 });
    const run = model.runs[model.runOrder[0] as string] as PipeRun;
    expect(run.start).toEqual({ point: [1000, 3000, 1500] });
    expect(run.end).toEqual({ point: [5000, 6000, 4000] });
    const checks = data<{ issues: Array<{ code: string }> }>(next, 'check_piping', {});
    expect(checks.issues.filter((issue) => issue.code === 'RTE_OPEN_END')).toHaveLength(2);
  });

  it('keeps the legacy pipe unless replace is set; replace deletes it (and reports the removed ids)', () => {
    const kept = ok(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' });
    expect(kept.document.building?.elements[s.pipeId]).toBeDefined();
    expect(kept.summary).toContain('legacy pipe kept');
    const replaced = ok(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150', replace: true });
    expect(replaced.document.building?.elements[s.pipeId]).toBeUndefined();
    expect(replaced.affected).toContain(s.pipeId);
    expect((replaced.data as Converted).replaced).toBe(true);
    // The converted run's own entities are still there.
    const runId = (replaced.data as Converted).runId;
    expect(piping(replaced.document).entityIds[runId]?.length).toBeGreaterThan(0);
    for (const id of piping(replaced.document).entityIds[runId] ?? []) expect(replaced.document.entities[id]).toBeDefined();
  });

  it('adds the level elevation to the vertex z: a pipe 500 above a level at 3000 starts at z 3500', () => {
    const levelled = apply(cs150Document(), 'add_level', { name: 'Upper', elevation: 3000, height: 3000, makeActive: true });
    const created = ok(levelled, 'add_pipe_run', {
      points: [
        [0, 0, 500],
        [2000, 0, 500],
      ],
      dn: 100,
      line: 'L-2',
    });
    const next = apply(created.document, 'convert_pipe_run', { pipeId: created.affected[0], spec: 'CS150' });
    const run = piping(next).runs[piping(next).runOrder[0] as string] as PipeRun;
    expect(run.start.point).toEqual([0, 0, 3500]);
    expect(run.end.point).toEqual([2000, 0, 3500]);
  });

  it('merges collinear vertices: 2000 + 1000 along +X is one leg, one elbow, cuts 1848 / 848', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 0, 0],
        [2000, 1000, 0],
      ],
      { dn: 100, line: 'L-3' },
    );
    const result = data<Converted>(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' });
    expect(result.pis).toEqual([[2000, 0, 0]]);
    expect(result.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([1848, 848]);
  });

  it('treats a vertex that bends by no more than the spec tolerance (1 deg) as straight: a 0.29 deg kink merges and is reported', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 5, 0],
        [2000, 1005, 0],
      ],
      { dn: 100, line: 'L-6' },
    );
    const result = data<Converted & { mergedPoints: number }>(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' });
    expect(result.mergedPoints).toBe(1);
    expect(result.pis).toEqual([[2000, 5, 0]]);
    expect(result.counts).toMatchObject({ elbow90LR: 1, pipePieces: 2 });
  });

  it('refuses a 4 deg kink: it and the 86 deg bend after it have no spec elbow (vertices 1 and 2)', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 70, 0],
        [2000, 1070, 0],
      ],
      { dn: 100, line: 'L-7' },
    );
    const refused = expectRefusal(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' }, 'RTE_NO_FITTING_FOR_ANGLE', 'points.1');
    expect(refused.error?.detail?.['vertices']).toEqual([1, 2]);
  });

  it('takes the DN from the diameter when the pipe has none (114.3 mm = DN100) and builds the template line number', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      { diameter: 114.3 },
    );
    const result = data<Converted>(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' });
    expect(result.dn).toBe(100);
    expect(result.dnSource).toContain('pipe size table');
    expect(result.lineNumber).toMatch(/^100-process-.+-CS150$/);
    expect(result.pipePieces.map((piece) => piece.cutLengthMm)).toEqual([3000]);
  });

  it('puts the run on an existing line of the same size (no new line)', () => {
    const l = legacy();
    const withLine = apply(l.doc, 'create_pipeline', { service: 'CW', sequence: '1', spec: 'CS150', dn: 100 });
    const lineId = piping(withLine).lineOrder[0] as string;
    const result = ok(withLine, 'convert_pipe_run', { pipeId: l.pipeId, lineId });
    expect((result.data as Converted).lineCreated).toBe(false);
    expect(piping(result.document).lineOrder).toEqual([lineId]);
    expect(piping(result.document).runs[(result.data as Converted).runId]?.lineId).toBe(lineId);
    expect(result.affected).not.toContain(lineId);
  });

  it('is pure: the input document is unchanged and the result is repeatable', () => {
    const before = structuredClone(s.doc);
    const first = ok(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' });
    expect(s.doc).toEqual(before);
    expect(ok(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' }).document).toEqual(first.document);
  });
});

describe('convert_pipe_run refusals leave the document unchanged', () => {
  const s = legacy();

  it.each([
    ['an id that is not a pipe', { pipeId: 'pipe-nope', spec: 'CS150' }, 'RTE_UNKNOWN_PIPE', 'pipeId'],
    ['no spec and no line', { pipeId: s.pipeId }, 'RTE_SPEC_UNKNOWN', 'spec'],
    ['a spec that is not loaded', { pipeId: s.pipeId, spec: 'NOPE' }, 'RTE_SPEC_UNKNOWN', 'spec'],
    ['a line that does not exist', { pipeId: s.pipeId, lineId: 'line-nope' }, 'RTE_UNKNOWN_LINE', 'lineId'],
  ])('%s', (_name, params, code, path) => {
    expectRefusal(s.doc, 'convert_pipe_run', params, code, path);
  });

  it('a pipe whose size is not DN-tabulated and has no DN: RTE_SIZE_MISMATCH', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [3000, 0, 0],
      ],
      { diameter: 100 },
    );
    expectRefusal(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' }, 'RTE_SIZE_MISMATCH', 'pipeId');
  });

  it('a line of another size: RTE_SIZE_MISMATCH', () => {
    const withLine = apply(s.doc, 'create_pipeline', { service: 'CW', sequence: '1', spec: 'CS150', dn: 150 });
    expectRefusal(withLine, 'convert_pipe_run', { pipeId: s.pipeId, lineId: piping(withLine).lineOrder[0] }, 'RTE_SIZE_MISMATCH', 'lineId');
  });

  it('a line number already used: RTE_DUPLICATE_LINE_NUMBER, naming the line to pass as lineId', () => {
    const once = apply(s.doc, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' });
    const refused = expectRefusal(once, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' }, 'RTE_DUPLICATE_LINE_NUMBER', 'lineId');
    expect(refused.summary).toContain(`lineId: "${piping(once).lineOrder[0]}"`);
  });

  it('lists every bend with no spec elbow: two 60 degree bends are vertices 1 and 2', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [1500, 866.0254, 0],
        [2500, 866.0254, 0],
      ],
      { dn: 100, line: 'L-4' },
    );
    const refused = expectRefusal(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' }, 'RTE_NO_FITTING_FOR_ANGLE', 'points.1');
    expect(refused.error?.detail?.['vertices']).toEqual([1, 2]);
    const angles = refused.error?.detail?.['anglesDegAtVertices'] as number[];
    angles.forEach((angle) => expect(angle).toBeCloseTo(60, 3));
    expect(refused.error?.detail?.['anglesDeg']).toEqual([90, 45]);
    expect(refused.error?.paths).toEqual(['points.1', 'points.2']);
  });

  it('a leg too short for its elbows: RTE_SEGMENT_TOO_SHORT from the derivation (200 mm between two NPS 4 elbows)', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [1000, 200, 0],
        [2000, 200, 0],
      ],
      { dn: 100, line: 'L-5' },
    );
    const refused = expectRefusal(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' }, 'RTE_SEGMENT_TOO_SHORT');
    expect(refused.error?.detail?.['cutLengthMm']).toBe(-104);
  });

  it('a document that is not in millimetres', () => {
    expectRefusal({ ...s.doc, units: 'in' as const }, 'convert_pipe_run', { pipeId: s.pipeId, spec: 'CS150' }, 'RTE_UNITS_UNSUPPORTED');
  });
});

describe('convert_pipe_run reports what straightening moved', () => {
  it('the 0.29 deg kink at vertex 1 sits 2.499992 mm off the straightened leg: |cross((2000,5), (1000,0))| / |(2000,5)| = 5000 / 2000.00625', () => {
    const l = legacy(
      [
        [0, 0, 0],
        [1000, 0, 0],
        [2000, 5, 0],
        [2000, 1005, 0],
      ],
      { dn: 100, line: 'L-8' },
    );
    const result = data<Converted & { straightenedMaxOffsetMm: number }>(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' });
    expect(result.straightenedMaxOffsetMm).toBeCloseTo(2.499992, 6);
  });

  it('is 0 when nothing was merged', () => {
    const l = legacy();
    expect(
      data<{ straightenedMaxOffsetMm: number }>(l.doc, 'convert_pipe_run', { pipeId: l.pipeId, spec: 'CS150' }).straightenedMaxOffsetMm,
    ).toBe(0);
  });
});
