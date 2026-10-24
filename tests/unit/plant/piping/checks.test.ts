/**
 * Plant 02 RTE M2: `check_piping` (the core RTE_* issue codes and their severities) and `piping_connectivity` (the graph behind them). Expected values are
 * hand calculations from the catalogue stub: weld spacing max(4 t, 50 mm) with the NPS 4 wall 6.02 mm -> 50 mm, elbow 152, flange set 79.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { PipingModel } from '@aec/plant/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Line, headerScene, pumpToVessel, routedPumpToVessel, valveScene } from './rteFixtures';

const piping = (doc: CadDocument): PipingModel => doc.plant?.piping as PipingModel;

interface Issue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  ids: string[];
  paths: string[];
  message: string;
  detail: Record<string, unknown>;
  remediation: string;
}
interface Check {
  status: 'pass' | 'warn' | 'fail';
  issues: Issue[];
  counts: { errors: number; warnings: number; infos: number; byCode: Record<string, number> };
  unverified: boolean;
  reviewRequired: boolean;
  lineIds: string[];
  runIds: string[];
  limits: {
    handwheelCentreHeight: { valueMm: number | null; source: string };
    weldSpacing: { valueMm: number | null; defaulted: boolean };
  };
}

const check = (doc: CadDocument, params: Record<string, unknown> = {}): Check => data<Check>(doc, 'check_piping', params);
const codes = (result: Check): string[] => result.issues.map((issue) => issue.code);

/** A DN100 run from a butt-weld tie-in A: +X 1000, +Y `middle`, +X 1000 (two elbows 152 each; the middle leg is the interesting one). */
function zigzag(middle: number): { doc: CadDocument; lineId: string; runId: string } {
  const { doc: withLine, lineId } = cs150Line(100, '5001');
  const a = addTie(withLine, 'TP-A', [0, 0, 2000], [1, 0, 0]);
  const doc = apply(a.doc, 'route_pipe', {
    lineId,
    from: { portId: a.id },
    legs: [
      { direction: '+X', length: 1000 },
      { direction: '+Y', length: middle },
      { direction: '+X', length: 1000 },
    ],
  });
  return { doc, lineId, runId: piping(doc).runOrder[0] as string };
}

describe('check_piping on SC-RTE-01 and SC-RTE-02', () => {
  const s = routedPumpToVessel();

  it('SC-RTE-01: the only issue is RTE_SPEC_UNVERIFIED (draft spec, rows not grade A), status warn, unverified', () => {
    const result = check(s.doc, { lineIds: [s.line] });
    expect(codes(result)).toEqual(['RTE_SPEC_UNVERIFIED']);
    expect(result.status).toBe('warn');
    expect(result.unverified).toBe(true);
    expect(result.reviewRequired).toBe(false);
    expect(result.counts).toEqual({ errors: 0, warnings: 1, infos: 0, byCode: { RTE_SPEC_UNVERIFIED: 1 } });
    expect(result.issues[0]?.ids).toEqual([s.line]);
    expect(result.issues[0]?.remediation.length).toBeGreaterThan(0);
    expect(result.runIds).toEqual([s.runId]);
  });

  it('is a query: the same document comes back, and a second call gives the same answer', () => {
    const first = ok(s.doc, 'check_piping', { lineIds: [s.line] });
    expect(first.document).toBe(s.doc);
    expect(first.affected).toEqual([]);
    expect(first.summary).toContain('check_piping: warn on 1 line(s), 1 run(s)');
    expect(ok(s.doc, 'check_piping', { lineIds: [s.line] }).data).toEqual(first.data);
  });

  it('include limits the report to some codes; with none left the status is pass', () => {
    const result = check(s.doc, { include: ['RTE_OPEN_END'] });
    expect(result.issues).toEqual([]);
    expect(result.status).toBe('pass');
    expect(check(s.doc, { include: ['RTE_SPEC_UNVERIFIED'] }).status).toBe('warn');
  });

  it('refuses an unknown line and leaves the document alone', () => {
    expectRefusal(s.doc, 'check_piping', { lineIds: ['line-nope'] }, 'RTE_UNKNOWN_LINE', 'lineIds');
  });

  it('an empty document passes with nothing to say', () => {
    const result = check(cs150Line().doc);
    expect(result.status).toBe('pass');
    expect(result.runIds).toEqual([]);
    expect(result.unverified).toBe(false);
  });
});

describe('RTE_VALVE_OPERATOR_HEIGHT (VC-RTE-05)', () => {
  const v = valveScene();

  it('reports the valve whose handwheel centre (z 1800) is over the explicit 1500 mm limit, with its component id and the reference level', () => {
    const result = check(v.doc, { lineIds: [v.line], maxHandwheelCentreHeight: 1500 });
    const issue = result.issues.find((candidate) => candidate.code === 'RTE_VALVE_OPERATOR_HEIGHT');
    expect(issue?.ids).toEqual([v.valveId]);
    expect(issue?.severity).toBe('warning');
    expect(issue?.detail).toMatchObject({ heightMm: 1800, limitMm: 1500, handwheelCentre: [0, 0, 1800], stemHeightFromCatalogue: false });
    expect(issue?.detail['referenceLevel']).toEqual({ id: 'level-1', elevationMm: 0 });
    expect(result.status).toBe('warn');
    expect(result.limits.handwheelCentreHeight).toMatchObject({ valueMm: 1500 });
  });

  it('a limit at or above the height reports nothing; without a limit the check is skipped and says so (no code value exists)', () => {
    expect(codes(check(v.doc, { lineIds: [v.line], maxHandwheelCentreHeight: 1800 }))).toEqual(['RTE_SPEC_UNVERIFIED']);
    const skipped = check(v.doc, { lineIds: [v.line] });
    expect(codes(skipped)).toEqual(['RTE_SPEC_UNVERIFIED']);
    expect(skipped.limits.handwheelCentreHeight.valueMm).toBeNull();
    expect(skipped.limits.handwheelCentreHeight.source).toContain('not given');
  });

  it('measures from the highest building level at or below the handwheel: a level at 1000 makes the height 800', () => {
    const levelled = apply(v.doc, 'add_level', { name: 'Platform', elevation: 1000, height: 3000 });
    const over = check(levelled, { lineIds: [v.line], maxHandwheelCentreHeight: 700 });
    const issue = over.issues.find((candidate) => candidate.code === 'RTE_VALVE_OPERATOR_HEIGHT');
    expect(issue?.detail).toMatchObject({ heightMm: 800, limitMm: 700 });
    expect((issue?.detail['referenceLevel'] as { elevationMm: number }).elevationMm).toBe(1000);
    expect(codes(check(levelled, { lineIds: [v.line], maxHandwheelCentreHeight: 900 }))).not.toContain('RTE_VALVE_OPERATOR_HEIGHT');
  });
});

describe('open ends, fitting-to-fitting and weld spacing (VC-RTE-10)', () => {
  it('a run with a free end reports exactly one RTE_OPEN_END on its last pipe piece, with the position', () => {
    const { doc, lineId, runId } = zigzag(1000);
    const open = check(doc, { lineIds: [lineId] }).issues.filter((issue) => issue.code === 'RTE_OPEN_END');
    expect(open).toHaveLength(1);
    expect(open[0]?.ids).toEqual([`${runId}/pipe-3`, runId]);
    expect(open[0]?.detail).toMatchObject({ position: [2000, 1000, 2000], dn: 100, endType: 'BW' });
    expect(open[0]?.severity).toBe('warning');
  });

  it('304 mm between two NPS 4 elbows is fitting-to-fitting (cut 0): one RTE_FITTING_TO_FITTING, still one open end', () => {
    const { doc, lineId } = zigzag(304);
    const result = check(doc, { lineIds: [lineId] });
    expect(result.issues.filter((issue) => issue.code === 'RTE_FITTING_TO_FITTING')).toHaveLength(1);
    expect(result.issues.filter((issue) => issue.code === 'RTE_OPEN_END')).toHaveLength(1);
    expect(result.issues.find((issue) => issue.code === 'RTE_FITTING_TO_FITTING')?.detail).toMatchObject({ leg: 1, cutLengthMm: 0 });
  });

  it('340 mm leaves a 36 mm piece: RTE_WELD_SPACING against the named default max(4 t, 50 mm) = 50 mm', () => {
    const { doc, lineId, runId } = zigzag(340);
    const issue = check(doc, { lineIds: [lineId] }).issues.find((candidate) => candidate.code === 'RTE_WELD_SPACING');
    expect(issue?.detail).toEqual({
      cutLengthMm: 36,
      minWeldSpacingMm: 50,
      source: 'project default (BS 2633 4t / common 50 mm), defaulted: true',
      wallMm: 6.02,
    });
    expect(issue?.ids).toEqual([`${runId}/pipe-2`, runId]);
  });

  it('minWeldSpacing replaces the default and is named: 30 mm accepts the 36 mm piece, 40 mm flags it as a parameter', () => {
    const { doc, lineId } = zigzag(340);
    expect(codes(check(doc, { lineIds: [lineId], minWeldSpacing: 30 }))).not.toContain('RTE_WELD_SPACING');
    const flagged = check(doc, { lineIds: [lineId], minWeldSpacing: 40 });
    expect(flagged.issues.find((issue) => issue.code === 'RTE_WELD_SPACING')?.detail).toMatchObject({
      minWeldSpacingMm: 40,
      source: 'check_piping minWeldSpacing',
    });
    expect(flagged.limits.weldSpacing).toMatchObject({ valueMm: 40, defaulted: false });
    expect(check(doc, { lineIds: [lineId] }).limits.weldSpacing).toMatchObject({ valueMm: null, defaulted: true });
  });
});

describe('from / to text, duplicate line numbers, disconnected ports', () => {
  const s = routedPumpToVessel();

  it('accepts from / to naming the nozzle port id or the equipment tag, flags text the runs do not reach (RTE_FROM_TO_MISMATCH)', () => {
    expect(codes(check(s.doc, { lineIds: [s.line] }))).not.toContain('RTE_FROM_TO_MISMATCH');
    const byTag = apply(s.doc, 'update_pipeline', { lineId: s.line, from: 'p-101', to: 'V-101' });
    expect(codes(check(byTag, { lineIds: [s.line] }))).not.toContain('RTE_FROM_TO_MISMATCH');
    const wrong = apply(s.doc, 'update_pipeline', { lineId: s.line, from: 'P-999', to: '' });
    const issues = check(wrong, { lineIds: [s.line] }).issues.filter((issue) => issue.code === 'RTE_FROM_TO_MISMATCH');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toMatchObject({ field: 'from', text: 'P-999' });
    expect(issues[0]?.ids).toEqual([s.line]);
  });

  it('reports a line number used twice once, as an error (status fail)', () => {
    const lines = piping(s.doc).lines;
    const first = lines[s.line];
    if (first === undefined) throw new Error('no line');
    const second = { ...first, id: 'line-copy' };
    const twice: CadDocument = {
      ...s.doc,
      plant: {
        ...s.doc.plant,
        piping: { ...piping(s.doc), lines: { ...lines, 'line-copy': second }, lineOrder: [...piping(s.doc).lineOrder, 'line-copy'] },
      },
    };
    const result = check(twice);
    const duplicates = result.issues.filter((issue) => issue.code === 'RTE_DUPLICATE_LINE_NUMBER');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ severity: 'error', ids: [s.line, 'line-copy'] });
    expect(result.status).toBe('fail');
  });

  it('lists a nozzle or tie-in without a run as RTE_DISCONNECTED_PORT (info) only when no lines are named; it never changes the status', () => {
    const spare = addTie(s.doc, 'SPARE', [9000, 9000, 0], [0, 0, 1]);
    const all = check(spare.doc);
    const ports = all.issues.filter((issue) => issue.code === 'RTE_DISCONNECTED_PORT');
    expect(ports.map((issue) => [issue.ids, issue.severity])).toEqual([[[spare.id], 'info']]);
    expect(all.counts.infos).toBe(1);
    expect(all.status).toBe('warn');
    expect(codes(check(spare.doc, { lineIds: [s.line] }))).not.toContain('RTE_DISCONNECTED_PORT');
  });

  it('a pump with an unused nozzle is a disconnected port too (equipment nozzles are ports)', () => {
    const base = pumpToVessel();
    const result = check(base);
    expect(result.issues.map((issue) => issue.ids[0])).toEqual(['P-101:N2', 'V-101:N1']);
  });
});

describe('a run that no longer derives is an error issue, not a refusal', () => {
  it('a nozzle that changed rating gives the RTE_RATING_MISMATCH of the derivation with the run id, status fail', () => {
    const s = routedPumpToVessel();
    const changed = apply(s.doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', rating: 'CL300' });
    const result = check(changed, { lineIds: [s.line] });
    const issue = result.issues.find((candidate) => candidate.code === 'RTE_RATING_MISMATCH');
    expect(issue?.severity).toBe('error');
    expect(issue?.ids[0]).toBe(s.runId);
    expect(result.status).toBe('fail');
    // The rest of the model is still checked: the line is unverified only when it has a derivable run, so no RTE_SPEC_UNVERIFIED here.
    expect(result.counts.errors).toBe(1);
  });
});

describe('piping_connectivity (VC-RTE-07)', () => {
  const s = routedPumpToVessel();

  interface Graph {
    nodes: Array<{ id: string; kind: string; partKind?: string; portKind?: string }>;
    edges: Array<{ from: string; to: string; kind: string; jointKind?: string }>;
    openEnds: unknown[];
    components: string[][];
    mismatches: unknown[];
    path?: string[] | null;
    runs: string[];
    brokenRuns: Array<{ runId: string; code: string }>;
  }

  it('SC-RTE-01 is one connected group with no open end: 15 parts, the two nozzles as port nodes, bolt sets joined to their flanges', () => {
    const graph = data<Graph>(s.doc, 'piping_connectivity', { lineIds: [s.line] });
    expect(graph.nodes.filter((node) => node.kind === 'part')).toHaveLength(15);
    expect(graph.nodes.filter((node) => node.kind === 'port').map((node) => node.id)).toEqual(['P-101:N2', 'V-101:N1']);
    expect(graph.openEnds).toEqual([]);
    expect(graph.mismatches).toEqual([]);
    expect(graph.components).toHaveLength(1);
    expect(graph.edges.some((edge) => edge.kind === 'attachment')).toBe(true);
    expect(graph.edges.filter((edge) => edge.jointKind === 'flanged').length).toBeGreaterThanOrEqual(2);
  });

  it('gives the shortest chain between two ports, through every part of the line in order', () => {
    const graph = data<Graph>(s.doc, 'piping_connectivity', { from: 'P-101:N2', to: 'V-101:N1' });
    expect(graph.path?.[0]).toBe('P-101:N2');
    expect(graph.path?.at(-1)).toBe('V-101:N1');
    expect(graph.path?.filter((id) => id.includes('/pipe-'))).toEqual([1, 2, 3, 4, 5].map((k) => `${s.runId}/pipe-${k}`));
  });

  it('path is null between things that are not connected, and works between part ids', () => {
    const other = addTie(s.doc, 'SPARE', [9000, 9000, 0], [0, 0, 1]);
    expect(data<Graph>(other.doc, 'piping_connectivity', { from: 'P-101:N2', to: `${s.runId}/pipe-5` }).path).toHaveLength(12);
    const apart = apply(other.doc, 'create_pipeline', { service: 'P', sequence: '9', spec: 'CS150', dn: 100 });
    const line = piping(apart).lineOrder.at(-1) as string;
    const routed = apply(apart, 'route_pipe', { lineId: line, from: { portId: other.id }, legs: [{ direction: '+Z', length: 500 }] });
    const run = piping(routed).runOrder.at(-1) as string;
    const result = ok(routed, 'piping_connectivity', { from: 'P-101:N2', to: `${run}/pipe-1` });
    expect((result.data as Graph).path).toBeNull();
    expect(result.summary).toContain('no path from P-101:N2');
  });

  it('SC-RTE-03 branches are part of the one component; a free branch end is the one open end', () => {
    const h = headerScene();
    const doc = apply(h.doc, 'add_branch', {
      runId: h.headerId,
      at: { point: [7000, 0, 3000] },
      dn: 50,
      legs: [{ direction: '+Z', length: 1000 }],
    });
    const graph = data<Graph>(doc, 'piping_connectivity', { lineIds: [h.lineId] });
    expect(graph.openEnds).toHaveLength(1);
    expect(graph.components).toHaveLength(1);
    expect(
      graph.edges.some((edge) => [edge.from, edge.to].sort().join() === [`${h.headerId}/olet-1`, `${h.headerId}/pipe-1`].sort().join()),
    ).toBe(true);
    // The olet is welded to the header piece, so the header ports and olet ports are all accounted for.
    expect(graph.runs).toHaveLength(2);
  });

  it('lists a run that no longer derives in brokenRuns and leaves it out', () => {
    const changed = apply(s.doc, 'update_nozzle', { equipment: 'V-101', mark: 'N1', dn: 150 });
    const result = ok(changed, 'piping_connectivity', { lineIds: [s.line] });
    expect((result.data as Graph).brokenRuns.map((run) => [run.runId, run.code])).toEqual([[s.runId, 'RTE_SIZE_MISMATCH']]);
    expect((result.data as Graph).nodes).toEqual([]);
    expect(result.summary).toContain('1 broken run(s) left out');
  });

  it('refuses unknown lines and unknown or single path ends', () => {
    expectRefusal(s.doc, 'piping_connectivity', { lineIds: ['line-nope'] }, 'RTE_UNKNOWN_LINE', 'lineIds');
    expectRefusal(s.doc, 'piping_connectivity', { from: 'P-101:N2', to: 'nowhere' }, 'RTE_UNKNOWN_PORT', 'to');
    expectRefusal(s.doc, 'piping_connectivity', { from: 'P-101:N2' }, 'RTE_UNKNOWN_PORT', 'from');
  });
});

describe('query results do not alias the derivation memo', () => {
  it('mutating a piping_takeoff answer (or failing to: it is frozen) leaves the next answer and the checks unchanged', () => {
    const s = routedPumpToVessel();
    const first = data<{ legs: Array<{ cutLengthsMm: number[]; start: number[] }>; joints: Array<{ position: number[] }> }>(
      s.doc,
      'piping_takeoff',
      { runId: s.runId },
    );
    const original = JSON.stringify(first);
    for (const attempt of [
      () => (first.legs[0] as { cutLengthsMm: number[] }).cutLengthsMm.splice(0, 1, -1),
      () => ((first.joints[0] as { position: number[] }).position[0] = 12345),
      () => ((first.legs[0] as { start: number[] }).start[0] = 99),
    ])
      try {
        attempt();
      } catch {
        // frozen: the write is refused, which is the point
      }
    const again = data(s.doc, 'piping_takeoff', { runId: s.runId });
    expect(JSON.stringify(again)).toBe(original);
    expect(codes(check(s.doc, { lineIds: [s.line] }))).toEqual(['RTE_SPEC_UNVERIFIED']);
  });

  it('the answer of an inline insert shares nothing writable either', () => {
    const v = valveScene();
    const faces = v.insert['facePositions'] as number[][];
    expect(Object.isFrozen(faces) && Object.isFrozen(faces[0])).toBe(true);
  });
});
