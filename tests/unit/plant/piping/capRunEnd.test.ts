/**
 * Plant 02 RTE CAT-FU: a cap as a run end (`set_run_end_cap`). The cap row is a DECLARED TEST INPUT on the small-bore scene (SW800, NPS 1 SW elbow
 * centre-to-mouth 41, socket depth 13, socket gap 1.6): length 20, round number labelled as such, never a standard's value.
 * Hand calculation: the pipe sits 13 - 1.6 = 11.4 mm inside every socket. Leg 1 (1500 mm, +X) starts at its elbow mouth 41: without a cap the open end
 * leaves the last piece 1500 - (41 - 11.4) = 1470.4; with the cap [1480, 1500] it ends 11.4 inside the cap socket: 1491.4 - 29.6 = 1461.8. Leg 0 with a
 * start cap [0, 20]: starts at 20 - 11.4 = 8.6 and ends at 959 + 11.4 = 970.4: 961.8.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PipeRun, PipingModel } from '@aec/plant/types';
import { deriveRun } from '@aec/plant/piping/routeParts';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { data } from '../../../helpers/commandAssertions';
import { capCatalog, capSpecOps } from './capFixtures';
import { smallBoreDocument } from './smallBoreFixtures';

function plain(): { doc: CadDocument; line: string; tie: string } {
  let doc = smallBoreDocument('spec_sw800.json');
  doc = apply(doc, 'create_pipeline', { service: 'P', sequence: '1', spec: 'SW800', dn: 25 });
  doc = apply(doc, 'add_tie_in_point', { tag: 'A', position: [0, 0, 0], direction: [0, 0, 1], dn: 25, endType: 'SW' });
  const piping = doc.plant?.piping as PipingModel;
  return { doc, line: piping.lineOrder.at(-1) as string, tie: piping.tieInOrder.at(-1) as string };
}
function scene(ref = 'cap-sw'): { doc: CadDocument; line: string; tie: string } {
  const s = plain();
  let doc = apply(s.doc, 'import_piping_catalog', { catalog: capCatalog });
  const spec = doc.plant?.spec?.specs['SW800']?.at(-1);
  doc = apply(doc, 'edit_pipe_spec', { specId: 'SW800', ops: capSpecOps(ref, spec?.catalogs ?? []) });
  return { ...s, doc };
}
const legs = [
  { direction: '+Z', length: 1000 },
  { direction: '+X', length: 1500 },
];
const runOf = (doc: CadDocument, runId: string): PipeRun => (doc.plant?.piping as PipingModel).runs[runId] as PipeRun;
const derivedOf = (doc: CadDocument, runId: string): Extract<ReturnType<typeof deriveRun>, { ok: true }> => {
  const derived = deriveRun(doc, runOf(doc, runId));
  if (!derived.ok) throw new Error(derived.message);
  return derived;
};
const cuts = (doc: CadDocument, runId: string): number[][] =>
  derivedOf(doc, runId).legs.map((leg) => leg.cutLengthsMm.map((cut) => +cut.toFixed(6)));
const openRun = (ref?: string): { doc: CadDocument; runId: string } => {
  const s = scene(ref);
  const routed = ok(s.doc, 'route_pipe', { lineId: s.line, from: { point: [0, 0, 0], direction: [0, 0, 1] }, legs });
  return { doc: routed.document, runId: (routed.data as { runId: string }).runId };
};

describe('set_run_end_cap', () => {
  it('caps the open end: last piece 1461.8 (was 1470.4), one cap part with one SW port, one more socket weld, no open end there', () => {
    const { doc, runId } = openRun();
    expect(cuts(doc, runId)).toEqual([[970.4], [1470.4]]);
    const before = derivedOf(doc, runId);
    const result = ok(doc, 'set_run_end_cap', { runId, end: 'end' });
    expect(result.affected).toEqual([runId]);
    expect(result.data).toMatchObject({ runId, end: 'end', capped: true, capLengthMm: 20, dn: 25 });
    expect(runOf(result.document, runId).end.cap).toBe(true);
    expect(cuts(result.document, runId)).toEqual([[970.4], [1461.8]]);
    const derived = derivedOf(result.document, runId);
    const cap = derived.parts.find((part) => part.kind === 'cap');
    expect(cap?.id).toBe(`${runId}/cap-1`);
    expect(cap?.ports).toHaveLength(1);
    expect(cap?.ports[0]).toMatchObject({ endType: 'SW', dn: 25 });
    expect(cap?.ports[0]?.direction.map((v) => v + 0)).toEqual([-1, 0, 0]);
    expect(cap?.ports[0]?.position[0]).toBeCloseTo(runOf(doc, runId).end.point[0] - 20, 9);
    expect(derived.joints.length).toBe(before.joints.length + 1);
    expect(derived.joints.some((joint) => joint.parts.includes(`${runId}/cap-1`) && joint.kind === 'socketWeld')).toBe(true);
    const check = ok(result.document, 'check_piping', {});
    const issues = (check.data as { issues: Array<{ code: string; ids: string[] }> }).issues;
    expect(issues.some((issue) => issue.code === 'RTE_OPEN_END' && issue.ids.includes(`${runId}/cap-1`))).toBe(false);
    expect(Object.keys(result.document.entities).some((id) => id.includes('cap-1'))).toBe(true);
  });

  it('caps the start too (961.8 and 1461.8, ids cap-1 / cap-2), and cap: false takes a cap off again exactly', () => {
    const { doc, runId } = openRun();
    const both = apply(apply(doc, 'set_run_end_cap', { runId, end: 'end' }), 'set_run_end_cap', { runId, end: 'start' });
    expect(cuts(both, runId)).toEqual([[961.8], [1461.8]]);
    const caps = derivedOf(both, runId).parts.filter((part) => part.kind === 'cap');
    expect(caps.map((part) => part.id)).toEqual([`${runId}/cap-1`, `${runId}/cap-2`]);
    expect(caps[0]?.ports[0]?.direction.map((v) => v + 0)).toEqual([0, 0, 1]);
    const first = apply(both, 'set_run_end_cap', { runId, end: 'start', cap: false });
    const open = apply(first, 'set_run_end_cap', { runId, end: 'end', cap: false });
    expect(runOf(open, runId).start).toEqual(runOf(doc, runId).start);
    expect(runOf(open, runId).end).toEqual(runOf(doc, runId).end);
    expect(cuts(open, runId)).toEqual(cuts(doc, runId));
  });

  it('counts the cap in the takeoff', () => {
    const { doc, runId } = openRun();
    const takeoff = ok(apply(doc, 'set_run_end_cap', { runId, end: 'end' }), 'piping_takeoff', {});
    const counts = (takeoff.data as { counts: Record<string, number> }).counts;
    expect(counts['cap']).toBe(1);
  });

  it('is a no-op when the end is already in the requested state', () => {
    const { doc, runId } = openRun();
    const again = execute(doc, 'set_run_end_cap', { runId, end: 'end', cap: false });
    expect(again.rejected).toBeUndefined();
    expect(again.affected).toEqual([]);
    expect(again.document).toBe(doc);
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    expect(execute(capped, 'set_run_end_cap', { runId, end: 'end' }).affected).toEqual([]);
  });

  it('refuses an unknown run, an end with a port, and an end another run continues from', () => {
    const s = scene();
    expectRefusal(s.doc, 'set_run_end_cap', { runId: 'run-nope', end: 'end' }, 'RTE_UNKNOWN_RUN');
    const routed = ok(s.doc, 'route_pipe', { lineId: s.line, from: { portId: s.tie }, legs });
    const runId = (routed.data as { runId: string }).runId;
    expectRefusal(routed.document, 'set_run_end_cap', { runId, end: 'start' }, 'RTE_CAP_INVALID');
    const next = ok(routed.document, 'route_pipe', {
      lineId: s.line,
      from: { portId: `${runId}:end` },
      legs: [{ direction: '+X', length: 500 }],
    });
    expectRefusal(next.document, 'set_run_end_cap', { runId, end: 'end' }, 'RTE_CAP_INVALID');
  });

  it('refuses, document unchanged, when the spec has no cap row (nothing invented), the row has no length, or the cap is longer than its leg', () => {
    const p = plain();
    const routed = ok(p.doc, 'route_pipe', { lineId: p.line, from: { point: [0, 0, 0], direction: [0, 0, 1] }, legs });
    const noRow = expectRefusal(
      routed.document,
      'set_run_end_cap',
      { runId: (routed.data as { runId: string }).runId, end: 'end' },
      'RTE_SPEC_NO_COMPONENT',
    );
    expect(noRow.document).toBe(routed.document);
    const missing = openRun('cap-nolength');
    expectRefusal(missing.doc, 'set_run_end_cap', { runId: missing.runId, end: 'end' }, 'RTE_SPEC_NO_COMPONENT');
    const huge = openRun('cap-huge');
    const refused = execute(huge.doc, 'set_run_end_cap', { runId: huge.runId, end: 'end' });
    expect(refused.rejected).toBe(true);
    expect(refused.document).toBe(huge.doc);
    expect(refused.error?.code).toBe('RTE_SEGMENT_TOO_SHORT');
  });

  it('is pure', () => {
    const { doc, runId } = openRun();
    expectPure(doc, () => execute(doc, 'set_run_end_cap', { runId, end: 'end' }));
  });

  it('load validation: cap must be true and never with a port ref', () => {
    const { doc, runId } = openRun();
    const piping = JSON.parse(JSON.stringify(doc.plant?.piping)) as { runs: Record<string, { end: Record<string, unknown> }> };
    const end = (piping.runs[runId] as { end: Record<string, unknown> }).end;
    expect(pipingErrors(piping)).toEqual([]);
    end['cap'] = true;
    expect(pipingErrors(piping)).toEqual([]);
    end['cap'] = false;
    expect(pipingErrors(piping).join()).toContain('cap must be true');
    end['cap'] = true;
    end['ref'] = { kind: 'tieIn', id: 'x' };
    expect(pipingErrors(piping).join()).toContain('cannot be capped');
  });

  it('an end that is capped and also has a port (hand-edited document) does not derive: RTE_CAP_INVALID', () => {
    const { doc, runId } = openRun();
    const run = runOf(apply(doc, 'set_run_end_cap', { runId, end: 'end' }), runId);
    const bad = { ...run, end: { ...run.end, ref: { kind: 'tieIn' as const, id: 'nope' } } };
    const derived = deriveRun(doc, bad);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.code).toBe('RTE_CAP_INVALID');
  });
});

describe('set_run_end_cap: review follow-ups', () => {
  const single = (length: number): { doc: CadDocument; runId: string } => {
    const s = scene();
    const routed = ok(s.doc, 'route_pipe', {
      lineId: s.line,
      from: { point: [0, 0, 0], direction: [1, 0, 0] },
      legs: [{ direction: '+X', length }],
    });
    return { doc: routed.document, runId: (routed.data as { runId: string }).runId };
  };

  it('a single leg of 200 capped at both ends: one piece from 20 - 11.4 = 8.6 to 180 + 11.4 = 191.4, cut 182.8', () => {
    const { doc, runId } = single(200);
    const both = apply(apply(doc, 'set_run_end_cap', { runId, end: 'start' }), 'set_run_end_cap', { runId, end: 'end' });
    expect(cuts(both, runId)).toEqual([[182.8]]);
    expect(derivedOf(both, runId).parts.filter((part) => part.kind === 'cap')).toHaveLength(2);
  });

  it('two caps (20 + 20) on a leg of 30 do not fit: RTE_SEGMENT_TOO_SHORT, document unchanged', () => {
    const { doc, runId } = single(30);
    const one = apply(doc, 'set_run_end_cap', { runId, end: 'start' });
    const refused = expectRefusal(one, 'set_run_end_cap', { runId, end: 'end' }, 'RTE_SEGMENT_TOO_SHORT');
    expect(refused.document).toBe(one);
  });

  it('edit_route stretch_leg keeps the cap and the cap follows the new end point', () => {
    const { doc, runId } = openRun();
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    const stretched = apply(capped, 'edit_route', { runId, op: 'stretch_leg', index: 1, length: 1800 });
    const run = runOf(stretched, runId);
    expect(run.end.cap).toBe(true);
    expect(run.end.point[0]).toBeCloseTo(1800, 6);
    const cap = derivedOf(stretched, runId).parts.find((part) => part.kind === 'cap');
    expect(cap?.centre?.[0]).toBeCloseTo(1800, 6);
    expect(cap?.ports[0]?.position[0]).toBeCloseTo(1780, 6);
    expect(cuts(stretched, runId)).toEqual([[970.4], [1761.8]]);
  });

  it('routing from a capped end is refused with RTE_CAP_INVALID, and works again once the cap is off', () => {
    const { doc, runId } = openRun();
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    const line = runOf(capped, runId).lineId;
    const params = { lineId: line, from: { portId: `${runId}:end` }, legs: [{ direction: '+X', length: 500 }] };
    const refused = expectRefusal(capped, 'route_pipe', params, 'RTE_CAP_INVALID');
    expect(refused.summary).toContain('set_run_end_cap');
    expect(ok(apply(capped, 'set_run_end_cap', { runId, end: 'end', cap: false }), 'route_pipe', params).rejected).toBeUndefined();
  });

  it('load validation rejects a run that continues from a capped end', () => {
    const { doc, runId } = openRun();
    const piping = JSON.parse(JSON.stringify(doc.plant?.piping)) as {
      runs: Record<string, { start: Record<string, unknown>; end: Record<string, unknown> }>;
    };
    piping.runs[runId]?.end && (piping.runs[runId].end['cap'] = true);
    const other = JSON.parse(JSON.stringify(piping.runs[runId])) as { id: string; start: Record<string, unknown> };
    other.id = 'run-x';
    other.start['ref'] = { kind: 'runEnd', runId, end: 'end' };
    const withOther = {
      ...piping,
      runs: { ...piping.runs, ['run-x']: other },
      runOrder: [...(piping as unknown as { runOrder: string[] }).runOrder, 'run-x'],
    };
    expect(pipingErrors(withOther).join()).toContain('capped end');
  });

  it('export_pcf writes exactly one CAP record with one END-POINT at the mouth', () => {
    const { doc, runId } = openRun();
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    const { files } = data<{ files: Array<{ content: string }> }>(capped, 'export_pcf', {});
    const lines = files.flatMap((file) => file.content.split(String.fromCharCode(10)));
    const starts = lines.flatMap((line, index) => (line === 'CAP' ? [index] : []));
    const body = lines
      .slice((starts[0] ?? 0) + 1)
      .filter((line, index, all) => all.slice(0, index).every((prior) => prior.startsWith(' ')));
    expect(starts).toHaveLength(1);
    const endPoints = body.filter((line) => line.includes('END-POINT'));
    expect(endPoints).toHaveLength(1);
    expect(endPoints[0]?.trim()).toBe('END-POINT 1480.0 0.0 1000.0 25 SW');
  });

  it('export_ifc adds one cap fitting, one port and one port connection (the cap mouth pairs with the pipe)', () => {
    const { doc, runId } = openRun();
    const capped = apply(doc, 'set_run_end_cap', { runId, end: 'end' });
    type Ifc = { ifc: string; piping: { productCount: number; portCount: number; connectionCount: number } };
    const [before, after] = [data<Ifc>(doc, 'export_ifc', {}), data<Ifc>(capped, 'export_ifc', {})];
    expect(after.piping.productCount).toBe(before.piping.productCount + 1);
    expect(after.piping.portCount).toBe(before.piping.portCount + 1);
    expect(after.piping.connectionCount).toBe(before.piping.connectionCount + 1);
    expect(after.ifc.split('.OBSTRUCTION.').length - 1).toBe(1);
    expect(before.ifc.split('.OBSTRUCTION.').length - 1).toBe(0);
  });
});
