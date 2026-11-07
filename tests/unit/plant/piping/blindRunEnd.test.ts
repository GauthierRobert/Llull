/**
 * Plant 02 RTE (ISO M6c): a blind flange as a run end (`set_run_end_cap closure blindFlange`). The blind row is a DECLARED TEST INPUT (thickness 22.4 mm, the weld-neck stub's
 * value; a blind's own table value is not in the repo). CS150 DN100: weld-neck flange Y = 76, spiral-wound gasket 3, NPS 4 LR 90 elbow A = 152.
 * Hand calculation: a 3000 + 2000 mm run (the elbow centre at 3000) closed by a blind at its end: the blind occupies [2000 - 22.4, 2000], the gasket 3 mm and the flange 76 mm
 * behind it, so the last pipe piece runs from 152 to 2000 - 22.4 - 3 - 76 = 1898.6 mm along the leg: cut 1746.6 mm (open end 2000 - 152 = 1848).
 */

import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { cs150Document } from './rteFixtures';
import { BLIND_THICKNESS_MM, extrasDocument } from '../fabrication/routeExtraFixtures';

const legs = [
  { direction: '+X', length: 3000 },
  { direction: '+Y', length: 2000 },
];
function openRun(base: CadDocument = extrasDocument()): { doc: CadDocument; runId: string; lineId: string } {
  const created = ok(base, 'create_pipeline', { service: 'P', sequence: '3002', spec: 'CS150', dn: 100 });
  const lineId = created.affected[0] as string;
  const routed = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs });
  return { doc: routed.document, runId: routed.affected[0] as string, lineId };
}
const runOf = (doc: CadDocument, runId: string): PipeRun => (doc.plant?.piping as PipingModel).runs[runId] as PipeRun;
const derivedOf = (doc: CadDocument, runId: string): Extract<ReturnType<typeof deriveRun>, { ok: true }> => {
  const derived = deriveRun(doc, runOf(doc, runId));
  if (!derived.ok) throw new Error(derived.message);
  return derived;
};
const blindOf = { runId: '', end: 'end', closure: 'blindFlange' } as const;

describe('set_run_end_cap closure blindFlange', () => {
  it('closes the end with flange set + blind: last piece 1746.6 (was 1848), blind outer face at the run end, one more flanged joint', () => {
    const { doc, runId } = openRun();
    expect(derivedOf(doc, runId).legs[1]?.cutLengthsMm).toEqual([1848]);
    const result = ok(doc, 'set_run_end_cap', { ...blindOf, runId });
    expect(result.affected).toEqual([runId]);
    expect(result.data).toMatchObject({
      runId,
      end: 'end',
      capped: true,
      closure: 'blindFlange',
      capLengthMm: BLIND_THICKNESS_MM,
      dn: 100,
    });
    expect(runOf(result.document, runId).end.blind).toBe(true);
    const derived = derivedOf(result.document, runId);
    expect(derived.legs[1]?.cutLengthsMm[0]).toBeCloseTo(1746.6, 9);
    const blind = derived.parts.find((part) => part.typeKey === 'flangeBlind');
    expect(blind?.kind).toBe('flange');
    expect(blind?.ports.map((port) => port.position[1])).toEqual([expect.closeTo(1977.6, 9)]);
    expect(blind?.centre?.[1]).toBe(2000);
    expect(blind?.ports.every((port) => port.endType === 'FL')).toBe(true);
    const gasket = derived.parts.find((part) => part.kind === 'gasket');
    expect(gasket?.ports.map((port) => port.position[1])).toEqual([expect.closeTo(1974.6, 9), expect.closeTo(1977.6, 9)]);
    expect(derived.parts.filter((part) => part.kind === 'boltSet')).toHaveLength(1);
    const joint = derived.joints.find((candidate) => candidate.parts.includes(blind?.id as string));
    expect(joint?.kind).toBe('flanged');
    expect(joint?.accessories).toHaveLength(2);
    const open = (document: CadDocument): number =>
      (ok(document, 'check_piping', {}).data as { issues: Array<{ code: string }> }).issues.filter((issue) => issue.code === 'RTE_OPEN_END')
        .length;
    expect(open(doc)).toBe(2);
    expect(open(result.document)).toBe(1);
  });

  it('is written as FLANGE-BLIND after its flange, gasket and bolt set in the PCF, and counted in the takeoff', () => {
    const { doc, runId, lineId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    const text = (data<{ files: Array<{ content: string }> }>(closed, 'export_pcf', { lineIds: [lineId] }).files[0] as { content: string })
      .content;
    expect(text).toContain('FLANGE-BLIND\n');
    expect(text.indexOf('FLANGE-BLIND')).toBeGreaterThan(text.indexOf('GASKET'));
    const counts = (ok(closed, 'piping_takeoff', {}).data as { counts: Record<string, number> }).counts;
    expect(counts['flangeBlind']).toBe(1);
    expect(counts['flangeWeldNeck']).toBe(1);
  });

  it('also closes the start; cap: false takes either closure off exactly; asking for the other closure replaces it', () => {
    const { doc, runId } = openRun();
    const both = apply(apply(doc, 'set_run_end_cap', { ...blindOf, runId }), 'set_run_end_cap', {
      runId,
      end: 'start',
      closure: 'blindFlange',
    });
    expect(derivedOf(both, runId).parts.filter((part) => part.typeKey === 'flangeBlind')).toHaveLength(2);
    expect(derivedOf(both, runId).legs[0]?.cutLengthsMm[0]).toBeCloseTo(3000 - 152 - (BLIND_THICKNESS_MM + 3 + 76), 9);
    const open = apply(apply(both, 'set_run_end_cap', { runId, end: 'start', cap: false }), 'set_run_end_cap', {
      ...blindOf,
      runId,
      cap: false,
    });
    expect(runOf(open, runId).start).toEqual(runOf(doc, runId).start);
    expect(runOf(open, runId).end).toEqual(runOf(doc, runId).end);
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    const replaced = apply(capped, 'set_run_end_cap', { ...blindOf, runId });
    expect(runOf(replaced, runId).end).toMatchObject({ blind: true });
    expect(runOf(replaced, runId).end.cap).toBeUndefined();
    const back = apply(replaced, 'set_run_end_cap', { runId, end: 'end', closure: 'cap' });
    expect(runOf(back, runId).end).toMatchObject({ cap: true });
    expect(runOf(back, runId).end.blind).toBeUndefined();
  });

  it('is a no-op when the end is already closed by a blind (or open and cap false)', () => {
    const { doc, runId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    const again = execute(closed, 'set_run_end_cap', { ...blindOf, runId });
    expect(again.affected).toEqual([]);
    expect(again.document).toBe(closed);
    expect(execute(doc, 'set_run_end_cap', { ...blindOf, runId, cap: false }).affected).toEqual([]);
  });

  it('refuses, document unchanged: unknown run, a port end, a spec without a blind row, one that does not fit its leg', () => {
    const { doc, runId, lineId } = openRun();
    expectRefusal(doc, 'set_run_end_cap', { ...blindOf, runId: 'run-nope' }, 'RTE_UNKNOWN_RUN');
    const plain = openRun(cs150Document());
    const noRow = expectRefusal(plain.doc, 'set_run_end_cap', { ...blindOf, runId: plain.runId }, 'RTE_SPEC_NO_COMPONENT');
    expect(noRow.document).toBe(plain.doc);
    const tooLong = ok(doc, 'edit_route', { runId, op: 'stretch_leg', index: 1, length: 200 });
    const refused = execute(tooLong.document, 'set_run_end_cap', { ...blindOf, runId });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(tooLong.document);
    const next = ok(doc, 'route_pipe', { lineId, from: { portId: `${runId}:end` }, legs: [{ direction: '+Y', length: 500 }] });
    expect(next.rejected).toBeUndefined();
    expectRefusal(next.document, 'set_run_end_cap', { ...blindOf, runId }, 'RTE_CAP_INVALID');
  });

  it('a closed end is no port: route_pipe from it is refused RTE_CAP_INVALID naming the blind flange', () => {
    const { doc, runId, lineId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    const refused = expectRefusal(
      closed,
      'route_pipe',
      { lineId, from: { portId: `${runId}:end` }, legs: [{ direction: '+X', length: 500 }] },
      'RTE_CAP_INVALID',
    );
    expect(refused.summary).toContain('blind flange');
  });

  it('edit_route stretch_leg keeps the blind and the blind follows the new end point (2500: pieces 2500 - 152 - 101.4 = 2246.6)', () => {
    const { doc, runId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    const stretched = apply(closed, 'edit_route', { runId, op: 'stretch_leg', index: 1, length: 2500 });
    expect(runOf(stretched, runId).end.blind).toBe(true);
    const derived = derivedOf(stretched, runId);
    expect(derived.legs[1]?.cutLengthsMm[0]).toBeCloseTo(2246.6, 9);
    expect(derived.parts.find((part) => part.typeKey === 'flangeBlind')?.centre?.[1]).toBeCloseTo(2500, 9);
  });

  it('survives a save and load: the blind end is still valid and derives the same parts', () => {
    const { doc, runId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    const loaded = deserializeDocument(serializeDocument(closed));
    expect(runOf(loaded, runId).end.blind).toBe(true);
    expect(derivedOf(loaded, runId).parts.map((part) => part.id)).toEqual(derivedOf(closed, runId).parts.map((part) => part.id));
  });

  it('deleting a run with a blind end removes its flange, gasket, bolts and blind: no entity, part or entity-id list is left', () => {
    const { doc, runId } = openRun();
    const closed = apply(doc, 'set_run_end_cap', { ...blindOf, runId });
    expect(Object.keys(closed.entities).some((id) => id.includes(runId))).toBe(true);
    const deleted = ok(closed, 'delete_pipe_run', { runId });
    const piping = deleted.document.plant?.piping as PipingModel;
    expect(piping.runs[runId]).toBeUndefined();
    expect(piping.entityIds?.[runId]).toBeUndefined();
    expect(Object.keys(deleted.document.entities).filter((id) => id.includes(runId))).toEqual([]);
    expect(Object.keys(deleted.document.entities).length).toBeLessThan(Object.keys(closed.entities).length);
  });

  it('replay_history re-mints the blind closure identically (parts, ids, entities), and the step before it still gives the open run', () => {
    const { doc, runId } = openRun();
    const closed = ok(doc, 'set_run_end_cap', { ...blindOf, runId });
    const replayed = execute(closed.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(closed.document.plant);
    expect(Object.keys(replayed.entities).sort()).toEqual(Object.keys(closed.document.entities).sort());
    expect(runOf(replayed, runId).end.blind).toBe(true);
    expect(runOf(doc, runId).end.blind).toBeUndefined();
  });

  it('is pure', () => {
    const { doc, runId } = openRun();
    expectPure(doc, () => execute(doc, 'set_run_end_cap', { ...blindOf, runId }));
  });

  it('load validation: blind must be true, never with a port ref or a cap; no run continues from a blind end', () => {
    const { doc, runId } = openRun();
    const piping = JSON.parse(JSON.stringify(doc.plant?.piping)) as { runs: Record<string, { end: Record<string, unknown> }> };
    const end = (piping.runs[runId] as { end: Record<string, unknown> }).end;
    end['blind'] = true;
    expect(pipingErrors(piping)).toEqual([]);
    end['blind'] = false;
    expect(pipingErrors(piping).join()).toContain('blind must be true');
    end['blind'] = true;
    end['cap'] = true;
    expect(pipingErrors(piping).join()).toContain('cannot be capped');
    delete end['cap'];
    end['ref'] = { kind: 'tieIn', id: 'x' };
    expect(pipingErrors(piping).join()).toContain('cannot take a blind flange');
  });

  it('an end that is both capped and blind (hand-edited document) does not derive: RTE_CAP_INVALID; with a port too', () => {
    const { doc, runId } = openRun();
    const run = runOf(doc, runId);
    const both = deriveRun(doc, { ...run, end: { ...run.end, cap: true, blind: true } });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.code).toBe('RTE_CAP_INVALID');
    const ported = deriveRun(doc, { ...run, end: { ...run.end, blind: true, ref: { kind: 'tieIn' as const, id: 'nope' } } });
    expect(ported.ok).toBe(false);
    if (!ported.ok) expect(ported.code).toBe('RTE_CAP_INVALID');
  });
});
