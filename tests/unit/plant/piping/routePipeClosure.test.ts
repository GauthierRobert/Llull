/**
 * Plant 02 RTE CAT-FU2: `route_pipe` closes an open start / end in the same call (`startClosure`, `endClosure`: cap | blindFlange), the state `set_run_end_cap`
 * would give afterwards. CS150 DN100 with the declared test rows (cap 64, blind 22.4): a 3000 + 2000 mm run closed by a blind at its end has a last piece
 * 2000 - 152 - (22.4 + 3 + 76) = 1746.6 mm; capped (64): 2000 - 152 - 64 = 1784 mm.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { execute } from '@core/commands/registry';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from './rteFixtures';
import { extrasDocument } from '../fabrication/routeExtraFixtures';

const legs = [
  { direction: '+X', length: 3000 },
  { direction: '+Y', length: 2000 },
];
function line(base: CadDocument = extrasDocument()): { doc: CadDocument; lineId: string } {
  const created = ok(base, 'create_pipeline', { service: 'P', sequence: '3004', spec: 'CS150', dn: 100 });
  return { doc: created.document, lineId: created.affected[0] as string };
}
const runOf = (doc: CadDocument, runId: string): PipeRun => (doc.plant?.piping as PipingModel).runs[runId] as PipeRun;
const lastPiece = (data: unknown): number => (data as { pipePieces: Array<{ cutLengthMm: number }> }).pipePieces.at(-1)?.cutLengthMm ?? NaN;

describe('route_pipe endClosure / startClosure', () => {
  it('endClosure cap: the run is the one set_run_end_cap gives afterwards (same stored state, same pieces), last piece 1784', () => {
    const { doc, lineId } = line();
    const together = ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, endClosure: 'cap' });
    const plain = ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs });
    const after = ok(plain.document, 'set_run_end_cap', { runId: plain.affected[0], end: 'end' });
    const runId = together.affected[0] as string;
    expect(lastPiece(together.data)).toBeCloseTo(1784, 6);
    expect(runOf(together.document, runId).end).toEqual(runOf(after.document, plain.affected[0] as string).end);
    expect(runOf(together.document, runId).end.cap).toBe(true);
    expect((together.data as { closures: unknown }).closures).toEqual({ start: null, end: 'cap' });
    expect(together.summary).toContain('route_pipe: run');
  });

  it('endClosure blindFlange (flange set + blind): last piece 1746.6; startClosure cap on the start of the run', () => {
    const { doc, lineId } = line();
    const result = ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, endClosure: 'blindFlange', startClosure: 'cap' });
    const run = runOf(result.document, result.affected[0] as string);
    expect(lastPiece(result.data)).toBeCloseTo(1746.6, 6);
    expect(run.end.blind).toBe(true);
    expect(run.start.cap).toBe(true);
    expect((result.data as { closures: unknown }).closures).toEqual({ start: 'cap', end: 'blindFlange' });
  });

  it('a closure on a port end is refused (RTE_CAP_INVALID, the path named), document unchanged', () => {
    const { doc, lineId } = line();
    const tie = addTie(doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 100 });
    expectRefusal(
      tie.doc,
      'route_pipe',
      { lineId, from: { portId: tie.id }, legs, endClosure: 'cap', startClosure: 'cap' },
      'RTE_CAP_INVALID',
      'startClosure',
    );
    const second = addTie(tie.doc, 'B', [3000, 2000, 0], [0, -1, 0], { dn: 100 });
    expectRefusal(
      second.doc,
      'route_pipe',
      { lineId, from: { point: [0, 0, 0] }, to: { portId: second.id }, legs: [{ direction: '+X', length: 3000 }], endClosure: 'cap' },
      'RTE_CAP_INVALID',
      'endClosure',
    );
  });

  it('a closure while branching is refused; a spec without the row is the RTE refusal with the document unchanged', () => {
    const { doc, lineId } = line();
    const header = ok(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 6000 }] });
    expectRefusal(
      header.document,
      'route_pipe',
      {
        lineId,
        from: { onRun: { runId: header.affected[0], at: { point: [3000, 0, 0] } } },
        legs: [{ direction: '+Y', length: 2000 }],
        endClosure: 'cap',
      },
      'RTE_CAP_INVALID',
      'endClosure',
    );
    const bare = line(cs150Document());
    expectRefusal(
      bare.doc,
      'route_pipe',
      { lineId: bare.lineId, from: { point: [0, 0, 0] }, legs, endClosure: 'cap' },
      'RTE_SPEC_NO_COMPONENT',
    );
    expectPure(doc, () => execute(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, endClosure: 'cap' }));
  });

  it('is applied by apply() like any run: the result derives and checks like a capped run', () => {
    const { doc, lineId } = line();
    const result = apply(doc, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs, endClosure: 'cap', startClosure: 'cap' });
    const checked = ok(result, 'check_piping', {});
    expect(JSON.stringify(checked.data)).not.toContain('RTE_OPEN_END');
  });
});
