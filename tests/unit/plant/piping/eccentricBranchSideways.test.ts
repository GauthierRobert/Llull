/**
 * Plant 02 RTE §13.18 / 05 ISO §13.11: a branch perpendicular to the offset of an eccentric reducer upstream (a horizontal branch off a flat-top
 * reducer). Hand check (CS150, NPS 6 OD 168.3 -> NPS 4 OD 114.3): e = (168.3 - 114.3) / 2 = 27 mm toward the flat (top = +Z); the branch axis lies on
 * the shifted leg, so its derived start is the stored start + [0, 0, 27].
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { execute } from '@core/commands/registry';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document, cs150Line } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Header {
  doc: CadDocument;
  runId: string;
  lineId: string;
}

/** DN150 header 4000 mm along +X (tie-in at the origin) and a 1000 mm riser; `reducer` puts a 6x4 eccentric reducer (flat top) at 2000. */
function header(reducer: boolean): Header {
  const line = cs150Line(150, '3101');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 150 });
  const routed = ok(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    legs: [
      { direction: '+X', length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    ...(reducer
      ? { inline: [{ type: 'reducerEccentric', tag: 'RE-1', dn2: 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } }] }
      : {}),
  });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId, lineId: line.lineId };
}

const tee = (runId: string, legs: unknown[] = [{ direction: '-Y', length: 500 }]): Record<string, unknown> => ({
  runId,
  at: { leg: 0, distance: 3000 },
  dn: 100,
  legs,
});

const branchRunOf = (doc: CadDocument, headerId: string): PipeRun =>
  Object.values(piping(doc).runs).find((run) => run.id !== headerId) as PipeRun;

const firstPipe = (doc: CadDocument, run: PipeRun): { start: readonly number[]; end: readonly number[] } => {
  const derived = deriveRun(doc, run);
  expect(derived.ok).toBe(true);
  const pipe = derived.ok ? derived.parts.find((part) => part.kind === 'pipe') : undefined;
  return { start: pipe?.ports[0]?.position ?? [], end: pipe?.ports[1]?.position ?? [] };
};

const pcfOf = (doc: CadDocument, input: Record<string, unknown> = {}): string =>
  (data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', input).files[0] as { content: string }).content;

describe('horizontal branch off a flat-top eccentric reducer', () => {
  const h = header(true);
  const added = ok(h.doc, 'add_branch', tee(h.runId));
  const branch = branchRunOf(added.document, h.runId);

  it('keeps the stored start on the stored axis, centres the tee on z 27 and starts the branch pipe on the shifted outlet (hand: 27, M 105)', () => {
    expect(branch.start.point).toEqual([3000, 0, 0]);
    const derivedHeader = deriveRun(added.document, piping(added.document).runs[h.runId] as PipeRun);
    const part = derivedHeader.ok ? derivedHeader.parts.find((candidate) => candidate.kind === 'tee') : undefined;
    expect(part?.centre?.[2]).toBeCloseTo(27, 9);
    expect(part?.ports[2]?.position[2]).toBeCloseTo(27, 9);
    expect(part?.ports[2]?.position[1]).toBeCloseTo(-105, 9);
    const pipe = firstPipe(added.document, branch);
    expect(pipe.start[0]).toBeCloseTo(3000, 6);
    expect(pipe.start[1]).toBeCloseTo(-105, 6);
    expect(pipe.start[2]).toBeCloseTo(27, 6);
    expect(pipe.end[2]).toBeCloseTo(27, 6);
    expect(pipe.end[1]).toBeCloseTo(-500, 6);
  });

  it('exports the TEE CENTRE-POINT and the branch pipe on the shifted axis', () => {
    const content = pcfOf(added.document);
    expect(content).toContain('CENTRE-POINT 3000.0 0.0 27.0');
    expect(content).toContain('BRANCH1-POINT 3000.0 -105.0 27.0');
  });

  it('add_branch is pure and reports the shifted position', () => {
    expectPure(h.doc, () => execute(h.doc, 'add_branch', tee(h.runId)));
    const position = data<{ position: number[] }>(h.doc, 'add_branch', tee(h.runId)).position;
    expect(position[0]).toBe(3000);
    expect(position[2]).toBeCloseTo(27, 9);
  });

  it('re-derives when the reducer is inserted upstream and removed again (stored branch run untouched)', () => {
    const plain = header(false);
    const withBranch = ok(plain.doc, 'add_branch', tee(plain.runId));
    const before = branchRunOf(withBranch.document, plain.runId);
    expect(firstPipe(withBranch.document, before).start[2]).toBeCloseTo(0, 6);
    const inserted = ok(withBranch.document, 'insert_inline_component', {
      runId: plain.runId,
      type: 'reducerEccentric',
      tag: 'RE-1',
      dn2: 100,
      flat: 'top',
      at: { leg: 0, centreDistance: 2000 },
    });
    const shifted = branchRunOf(inserted.document, plain.runId);
    expect(shifted.start.point).toEqual(before.start.point);
    expect(firstPipe(inserted.document, shifted).start[2]).toBeCloseTo(27, 6);
    const componentId = (piping(inserted.document).runs[plain.runId] as PipeRun).inline?.[0]?.id;
    const removed = ok(inserted.document, 'remove_inline_component', { runId: plain.runId, componentId });
    expect(firstPipe(removed.document, branchRunOf(removed.document, plain.runId)).start[2]).toBeCloseTo(0, 6);
  });

  it('replay_history re-mints the shifted branch identically', () => {
    const replayed = execute(added.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(added.document.plant);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(added.document.entities).sort());
  });

  it('a second leg along the offset (+Z) takes the shifted corner; one not along it is refused by name when the run derives', () => {
    const along = ok(
      h.doc,
      'add_branch',
      tee(h.runId, [
        { direction: '-Y', length: 500 },
        { direction: '+Z', length: 400 },
      ]),
    );
    expect(deriveRun(along.document, branchRunOf(along.document, h.runId)).ok).toBe(true);
    expectRefusal(
      h.doc,
      'add_branch',
      tee(h.runId, [
        { direction: '-Y', length: 500 },
        { direction: '+X', length: 400 },
      ]),
      'RTE_BRANCH_ON_FITTING',
    );
  });
});

describe('what the shifted branch axis cannot take', () => {
  const h = header(true);
  const added = ok(h.doc, 'add_branch', tee(h.runId));
  const branch = branchRunOf(added.document, h.runId);

  it('a branch end joined to a port cannot follow the shifted axis: refused by name', () => {
    const tied = addTie(added.document, 'B', [3000, -500, 0], [0, 1, 0], { dn: 100 });
    const run: PipeRun = { ...branch, end: { ...branch.end, ref: { kind: 'tieIn', id: tied.id } } };
    const derived = deriveRun(tied.doc, run);
    expect(derived.ok).toBe(false);
    expect(!derived.ok && derived.code).toBe('RTE_BRANCH_ON_FITTING');
  });

  it('a shifted branch run that carries branches of its own is refused by name (they would sit on the stored axis)', () => {
    const run: PipeRun = { ...branch, branches: [{ id: 'branch-x.1', leg: 0, distance: 200, branchRunId: 'nope' }] };
    const derived = deriveRun(added.document, run);
    expect(derived.ok).toBe(false);
    expect(!derived.ok && derived.code).toBe('RTE_BRANCH_ON_FITTING');
  });
});

describe('PCF round trip of the horizontal branch', () => {
  it("llull's PCF re-imports as a route and re-exports the same file", () => {
    const h = header(true);
    const added = ok(h.doc, 'add_branch', tee(h.runId));
    const text = pcfOf(added.document, { lineIds: [h.lineId] });
    const imported = execute(cs150Document(), 'import_pcf', { text, as: 'route', spec: 'CS150' });
    expect(imported.rejected, imported.summary).toBeUndefined();
    const bare = (value: string): string => value.replace(/^ {4}(UNIQUE-)?COMPONENT-IDENTIFIER .*\n/gm, '');
    expect(bare(pcfOf(imported.document))).toBe(bare(text));
  });
});
