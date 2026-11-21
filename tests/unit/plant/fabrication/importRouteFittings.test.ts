/**
 * Plant 05 ISO M6c: `import_pcf as route` takes eccentric reducers (axis offset carried through the plan, flat side measured or explicit) and caps (the capped
 * run end of 02 CAT-FU). Hand calculations from the CS150 stub: NPS 6 OD 168.3, NPS 4 OD 114.3 -> offset e = (168.3 - 114.3) / 2 = 27 mm; reducer 6x4 H = 140,
 * NPS 4 LR 90 elbow A = 152; cap length 64 (declared test input), so a 3000 + 2000 mm DN100 run capped at its end has a last piece 2000 - 152 - 64 = 1784 mm.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';
import { BLIND_THICKNESS_MM, CAP_LENGTH_MM, extrasDocument } from './routeExtraFixtures';

const exported = (doc: CadDocument, lineId: string): string =>
  (data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [lineId] }).files[0] as { content: string }).content;
/** The PCF of a line without the llull part ids (they carry the run id, which a different history gives another number). */
const bare = (text: string): string => text.replace(/^ {4}UNIQUE-COMPONENT-IDENTIFIER .*\n/gm, '');

interface RouteData {
  lineId: string;
  warnings: Array<{ code: string; ids?: string[] }>;
  route: {
    runs: Array<{ points: number[][]; capped: boolean; closure?: string; inline: Array<{ type: string; eccentric?: boolean }> }>;
    comparison: { pipeLengthDeltaMm: number; countDelta: Record<string, number> };
  };
}
const routeData = (result: CommandResult): RouteData => result.data as RouteData;
const firstRun = (doc: CadDocument): { end: { cap?: boolean }; inline: Array<Record<string, unknown>> } | undefined =>
  Object.values(doc.plant?.piping?.runs ?? {})[0] as { end: { cap?: boolean }; inline: Array<Record<string, unknown>> } | undefined;

/** A DN`dn` line from a butt-weld tie-in at the origin: +X 4000, +Z 1000 with an eccentric reducer to `dn2` (flat top) 2000 mm along the first leg. */
function eccentricLine(options: { dn?: number; dn2?: number; valve?: boolean } = {}): { doc: CadDocument; lineId: string } {
  const dn = options.dn ?? 150;
  const line = cs150Line(dn, '3001');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn });
  const routed = ok(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    legs: [
      { direction: '+X', length: 4000 },
      { direction: '+Z', length: 1000 },
    ],
    inline: [
      { type: 'reducerEccentric', dn2: options.dn2 ?? 100, flat: 'top', at: { leg: 0, centreDistance: 2000 } },
      ...(options.valve === true ? [{ type: 'valveGate', at: { leg: 0, centreDistance: 3000 } }] : []),
    ],
  });
  return { doc: routed.document, lineId: line.lineId };
}

const HEADER = 'ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE E-1\n    PIPING-SPEC CS150\n';
const record = (type: string, id: number, ends: string[], extra = ''): string =>
  `${type}\n    COMPONENT-IDENTIFIER ${id}\n${ends.map((end) => `    END-POINT ${end}\n`).join('')}${extra}`;
/** A hand-written line whose eccentric reducer 150 -> 100 has both end points on the X axis (the file does not say which side is flat). */
const collinear = (): string =>
  HEADER +
  record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '1930.0 0.0 0.0 150 BW']) +
  record('REDUCER-ECCENTRIC', 2, ['1930.0 0.0 0.0 150 BW', '2070.0 0.0 0.0 100 BW']) +
  record('PIPE', 3, ['2070.0 0.0 0.0 100 BW', '3848.0 0.0 0.0 100 BW']) +
  record('ELBOW', 4, ['3848.0 0.0 0.0 100 BW', '4000.0 0.0 152.0 100 BW'], '    CENTRE-POINT 4000.0 0.0 0.0\n    SKEY ELBW\n') +
  record('PIPE', 5, ['4000.0 0.0 152.0 100 BW', '4000.0 0.0 1000.0 100 BW']);
const base = cs150Document();
const route = (text: string, extra: Record<string, unknown> = {}, doc: CadDocument = base): CommandResult =>
  execute(doc, 'import_pcf', { text, as: 'route', spec: 'CS150', ...extra });

describe('eccentric reducers in route mode', () => {
  const { doc, lineId } = eccentricLine();
  const original = exported(doc, lineId);

  it('carries the 27 mm offset: the corner after the reducer is the stored point (4000, 0, 0), pipe and elbow unchanged, flat on top', () => {
    const result = route(original);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs[0]?.points).toEqual([
      [0, 0, 0],
      [4000, 0, 0],
      [4000, 0, 1000],
    ]);
    expect(info.route.runs[0]?.inline).toEqual([{ type: 'reducer', componentId: expect.any(String), eccentric: true }]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(firstRun(result.document)?.inline[0]).toMatchObject({ type: 'reducerEccentric', dn2: 100, flatDirection: [0, 0, 1] });
    expect(info.warnings.map((warning) => warning.code)).not.toContain('ISO_ROUTE_DIMENSIONS_CHANGED');
  });

  it('is a fixed point: export, import as route, export again gives the same PCF up to the part ids', () => {
    const first = route(original);
    expect(bare(exported(first.document, routeData(first).lineId))).toBe(bare(original));
  });

  it('an expander (DN100 -> DN150, flat top) puts the axis 27 mm below: same round trip', () => {
    const line = eccentricLine({ dn: 100, dn2: 150 });
    const text = exported(line.doc, line.lineId);
    expect(text).toContain('0.0 0.0 -27.0');
    const result = route(text);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.points[1]).toEqual([4000, 0, 0]);
    expect(bare(exported(result.document, routeData(result).lineId))).toBe(bare(text));
  });

  it('a valve downstream of the reducer on the same leg is planned on the stored axis', () => {
    const line = eccentricLine({ valve: true });
    const text = exported(line.doc, line.lineId);
    const result = route(text);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.inline.map((item) => item.type)).toEqual(['reducer', 'valve']);
    expect(bare(exported(result.document, routeData(result).lineId))).toBe(bare(text));
  });

  it('a file whose reducer ends are on one axis needs eccentricFlat: refused ISO_ROUTE_FLAT_MISSING, document unchanged', () => {
    const result = expectRefusal(base, 'import_pcf', { text: collinear(), as: 'route', spec: 'CS150' }, 'ISO_ROUTE_FLAT_MISSING');
    expect(result.error?.ids).toEqual(['pcf:E-1:2']);
    expect(result.summary).toContain('eccentricFlat');
    expect(result.document).toBe(base);
  });

  it('eccentricFlat top / bottom is the explicit side: the RTE offsets +27 / -27 and the next leg (+Z) takes it up', () => {
    const top = route(collinear(), { eccentricFlat: 'top' });
    expect(top.rejected, top.summary).toBeUndefined();
    expect(firstRun(top.document)?.inline[0]?.['flatDirection']).toEqual([0, 0, 1]);
    const bottom = route(collinear(), { eccentricFlat: 'bottom' });
    expect(bottom.rejected, bottom.summary).toBeUndefined();
    expect(firstRun(bottom.document)?.inline[0]?.['flatDirection']).toEqual([0, 0, -1]);
  });

  it('an eccentricFlat that disagrees with the offset of the file is ISO_PARAM_INVALID; one that agrees is accepted', () => {
    expectRefusal(base, 'import_pcf', { text: original, as: 'route', spec: 'CS150', eccentricFlat: 'bottom' }, 'ISO_PARAM_INVALID');
    expect(route(original, { eccentricFlat: 'top' }).rejected).toBeUndefined();
  });

  it('eccentricFlat applies to as route only', () => {
    expectRefusal(base, 'import_pcf', { text: original, eccentricFlat: 'top' }, 'ISO_PARAM_INVALID', 'eccentricFlat');
  });

  it('top / bottom on a vertical pipe is the RTE refusal RTE_ECCENTRIC_INVALID (the side is not guessable)', () => {
    const text =
      HEADER +
      record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '0.0 0.0 1930.0 150 BW']) +
      record('REDUCER-ECCENTRIC', 2, ['0.0 0.0 1930.0 150 BW', '0.0 0.0 2070.0 100 BW']) +
      record('PIPE', 3, ['0.0 0.0 2070.0 100 BW', '0.0 0.0 3000.0 100 BW']);
    expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150', eccentricFlat: 'top' }, 'RTE_ECCENTRIC_INVALID');
  });

  it('an offset the next leg cannot take up (the last leg) is the RTE refusal RTE_ECCENTRIC_OFFSET, document unchanged', () => {
    const text =
      HEADER +
      record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '1930.0 0.0 0.0 150 BW']) +
      record('REDUCER-ECCENTRIC', 2, ['1930.0 0.0 0.0 150 BW', '2070.0 0.0 27.0 100 BW']) +
      record('PIPE', 3, ['2070.0 0.0 27.0 100 BW', '4000.0 0.0 27.0 100 BW']);
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'RTE_ECCENTRIC_OFFSET');
    expect(result.document).toBe(base);
  });

  const teeFile = (branch: string): string =>
    HEADER +
    record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '1930.0 0.0 0.0 150 BW']) +
    record('REDUCER-ECCENTRIC', 2, ['1930.0 0.0 0.0 150 BW', '2070.0 0.0 27.0 100 BW']) +
    record(
      'TEE',
      3,
      ['2070.0 0.0 27.0 100 BW', '2500.0 0.0 27.0 100 BW'],
      `    CENTRE-POINT 2285.0 0.0 27.0\n    BRANCH1-POINT ${branch} 100 BW\n`,
    ) +
    record('PIPE', 4, ['2500.0 0.0 27.0 100 BW', '3848.0 0.0 27.0 100 BW']) +
    record('ELBOW', 5, ['3848.0 0.0 27.0 100 BW', '4000.0 0.0 179.0 100 BW'], '    CENTRE-POINT 4000.0 0.0 27.0\n    SKEY ELBW\n') +
    record('PIPE', 6, ['4000.0 0.0 179.0 100 BW', '4000.0 0.0 1000.0 100 BW']);

  it('a tee downstream of the reducer is rebuilt on the stored axis (branch along the offset); a branch across the offset is refused', () => {
    const result = route(teeFile('2285.0 0.0 200.0') + record('PIPE', 7, ['2285.0 0.0 200.0 100 BW', '2285.0 0.0 1000.0 100 BW']));
    expect(result.rejected).toBeUndefined();
    expect(routeData(result).route.runs).toHaveLength(2);
    const across = route(teeFile('2285.0 200.0 27.0') + record('PIPE', 7, ['2285.0 200.0 27.0 100 BW', '2285.0 1000.0 27.0 100 BW']));
    expect(across.rejected).toBe(true);
    expect(across.summary).toContain('RTE_BRANCH_ON_FITTING');
  });

  it('is pure: the document passed in is not changed', () => {
    expectPure(base, () => route(original));
  });
});

describe('caps in route mode', () => {
  const extras = extrasDocument();
  const created = ok(extras, 'create_pipeline', { service: 'P', sequence: '3002', spec: 'CS150', dn: 100 });
  const lineId = created.affected[0] as string;
  const routed = ok(created.document, 'route_pipe', {
    lineId,
    from: { point: [0, 0, 0] },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  const runId = routed.affected[0] as string;
  const capped = ok(routed.document, 'set_run_end_cap', { runId, end: 'end' });
  const original = exported(capped.document, lineId);

  it('the file gives the cap joint, the run ends one spec cap length beyond it: cap at the same place, last piece 1784, pipe delta 0', () => {
    expect(original).toContain('END-POINT 3000.0 1936.0 0.0 100 BW\n    ITEM-CODE CS150-CAP-BW-100');
    const result = route(original, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs[0]?.capped).toBe(true);
    expect(info.route.runs[0]?.points.at(-1)).toEqual([3000, 1936 + CAP_LENGTH_MM, 0]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(firstRun(result.document)?.end.cap).toBe(true);
    expect(info.route.comparison.countDelta).toEqual({});
  });

  it('is a fixed point: export, import as route, export again gives the same PCF up to the part ids', () => {
    const first = route(original, {}, extras);
    expect(bare(exported(first.document, routeData(first).lineId))).toBe(bare(original));
  });

  it('a CAP with two END-POINTs gives the closed end itself: the run ends there', () => {
    const text = original.replace(
      'END-POINT 3000.0 1936.0 0.0 100 BW\n    ITEM-CODE CS150-CAP',
      'END-POINT 3000.0 1936.0 0.0 100 BW\n    END-POINT 3000.0 2000.0 0.0 100 BW\n    ITEM-CODE CS150-CAP',
    );
    const result = route(text, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.points.at(-1)).toEqual([3000, 2000, 0]);
  });

  it('a spec without a cap row is the RTE refusal RTE_SPEC_NO_COMPONENT, document unchanged', () => {
    const result = expectRefusal(base, 'import_pcf', { text: original, as: 'route', spec: 'CS150' }, 'RTE_SPEC_NO_COMPONENT');
    expect(result.document).toBe(base);
  });

  it('a cap on a branch run is capped too (tee off a header, branch ends in a cap)', () => {
    const header = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 4000 }] });
    const branch = ok(header.document, 'add_branch', {
      runId: header.affected[0],
      at: { point: [2000, 0, 0] },
      dn: 100,
      legs: [{ direction: '+Y', length: 1500 }],
    });
    const withCap = ok(branch.document, 'set_run_end_cap', { runId: branch.affected[0], end: 'end' });
    const text = exported(withCap.document, lineId);
    expect(text).toContain('CAP\n');
    const result = route(text, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs.map((run) => run.capped)).toEqual([false, true]);
    expect(bare(exported(result.document, routeData(result).lineId))).toBe(bare(text));
  });
});

describe('blind flanges in route mode', () => {
  const extras = extrasDocument();
  const created = ok(extras, 'create_pipeline', { service: 'P', sequence: '3003', spec: 'CS150', dn: 100 });
  const lineId = created.affected[0] as string;
  const routed = ok(created.document, 'route_pipe', {
    lineId,
    from: { point: [0, 0, 0] },
    legs: [
      { direction: '+X', length: 3000 },
      { direction: '+Y', length: 2000 },
    ],
  });
  const closed = ok(routed.document, 'set_run_end_cap', { runId: routed.affected[0], end: 'end', closure: 'blindFlange' });
  const original = exported(closed.document, lineId);

  it('the run ends one blind thickness beyond the file joint: pipe 1746.6 + flange set + blind at the same place, delta 0', () => {
    expect(original).toContain('FLANGE-BLIND\n');
    const result = route(original, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs[0]).toMatchObject({ capped: true, closure: 'blindFlange' });
    expect(info.route.runs[0]?.points.at(-1)?.[1]).toBeCloseTo(1977.6 + BLIND_THICKNESS_MM, 9);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(firstRun(result.document)?.end).toMatchObject({ blind: true });
    expect(info.route.comparison.countDelta).toEqual({});
  });

  it('is a fixed point: export, import as route, export again gives the same PCF up to the part ids', () => {
    const first = route(original, {}, extras);
    expect(bare(exported(first.document, routeData(first).lineId))).toBe(bare(original));
  });

  it('a file without the gasket (flange then blind) is rebuilt with the spec gasket: only the count differs', () => {
    const text = original.replace(/GASKET\n(?: {4}.*\n)+/, '').replaceAll('1977.6', '1974.6');
    expect(text).not.toContain('GASKET\n');
    const result = route(text, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.closure).toBe('blindFlange');
    expect(Object.values(result.document.plant?.piping?.runs ?? {})).toHaveLength(1);
  });

  it('a FLANGE-BLIND with two END-POINTs gives its outer face itself: the run ends there', () => {
    const text = original.replace(
      /(FLANGE-BLIND\n(?: {4}.*\n)*? {4}END-POINT 3000.0 1977.6 0.0 100 FL\n)/,
      '$1    END-POINT 3000.0 2000.0 0.0 100 FL\n',
    );
    const result = route(text, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.points.at(-1)).toEqual([3000, 2000, 0]);
  });

  it('a file whose first free end is the blind walks from the other end', () => {
    const text = original.replace(
      /(FLANGE-BLIND\n(?: {4}.*\n)*? {4}END-POINT 3000.0 1977.6 0.0 100 FL\n)/,
      '$1    END-POINT 3000.0 2000.0 0.0 100 FL\n',
    );
    const blindBlock = /FLANGE-BLIND\n(?: {4}.*\n)+/.exec(text)?.[0] ?? '';
    const reordered = text.replace(blindBlock, '').replace('PIPE\n', `${blindBlock}PIPE\n`);
    const result = route(reordered, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.points[0]).toEqual([0, 0, 0]);
  });

  it('a spec without a blind row is the RTE refusal RTE_SPEC_NO_COMPONENT, document unchanged', () => {
    const result = expectRefusal(base, 'import_pcf', { text: original, as: 'route', spec: 'CS150' }, 'RTE_SPEC_NO_COMPONENT');
    expect(result.document).toBe(base);
  });

  it('closures at both free ends (a two-point CAP at each end) are refused when the spec has no cap row, document unchanged', () => {
    const text =
      HEADER +
      record('CAP', 1, ['0.0 0.0 0.0 100 BW', '64.0 0.0 0.0 100 BW']) +
      record('PIPE', 2, ['64.0 0.0 0.0 100 BW', '2000.0 0.0 0.0 100 BW']) +
      record('CAP', 3, ['2000.0 0.0 0.0 100 BW', '2064.0 0.0 0.0 100 BW']);
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'RTE_SPEC_NO_COMPONENT');
    expect(result.document).toBe(base);
  });
});

describe('a closure at the start of the main run (the line is closed at both ends)', () => {
  const extras = extrasDocument();
  const created = ok(extras, 'create_pipeline', { service: 'P', sequence: '3003', spec: 'CS150', dn: 100 });
  const lineId = created.affected[0] as string;
  const routed = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 3000 }] });
  const runId = routed.affected[0];
  const capped = ok(ok(routed.document, 'set_run_end_cap', { runId, end: 'start', cap: true }).document, 'set_run_end_cap', {
    runId,
    end: 'end',
    cap: true,
  });
  const blinded = ok(ok(routed.document, 'set_run_end_cap', { runId, end: 'start', closure: 'blindFlange' }).document, 'set_run_end_cap', {
    runId,
    end: 'end',
    closure: 'blindFlange',
  });
  const withTips = (text: string, mouth: string, tip: string, endType: string): string =>
    text.replace(
      new RegExp(`((?:CAP|FLANGE-BLIND)\\n(?: {4}.*\\n)*? {4}END-POINT ${mouth} 0.0 0.0 100 ${endType}\\n)`),
      `$1    END-POINT ${tip} 0.0 0.0 100 ${endType}\n`,
    );
  const capsFile = withTips(withTips(exported(capped.document, lineId), '64.0', '0.0', 'BW'), '2936.0', '3000.0', 'BW');
  const blindsFile = withTips(withTips(exported(blinded.document, lineId), '22.4', '0.0', 'FL'), '2977.6', '3000.0', 'FL');

  it('caps: the run starts at the first cap closed end, both ends are capped, the pipe is as long as in the file (delta 0)', () => {
    const result = route(capsFile, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as {
      route: {
        runs: Array<{ points: number[][]; capped: boolean; startClosure?: string; closure?: string }>;
        comparison: { pipeLengthDeltaMm: number; countDelta: Record<string, number> };
      };
    };
    expect(info.route.runs[0]).toMatchObject({ capped: true, startClosure: 'cap', closure: 'cap' });
    expect(info.route.runs[0]?.points).toEqual([
      [0, 0, 0],
      [3000, 0, 0],
    ]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(info.route.comparison.countDelta).toEqual({});
    const run = Object.values(result.document.plant?.piping?.runs ?? {})[0] as unknown as {
      start: { cap?: boolean };
      end: { cap?: boolean };
    };
    expect([run.start.cap, run.end.cap]).toEqual([true, true]);
  });

  it('blind flanges: flange, gasket and blind are rebuilt at both ends from the spec, and export gives the same PCF (fixed point)', () => {
    const result = route(blindsFile, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = result.data as {
      route: { runs: Array<{ points: number[][]; startClosure?: string; closure?: string }>; comparison: { pipeLengthDeltaMm: number } };
    };
    expect(info.route.runs[0]).toMatchObject({ startClosure: 'blindFlange', closure: 'blindFlange' });
    expect(info.route.runs[0]?.points).toEqual([
      [0, 0, 0],
      [3000, 0, 0],
    ]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(bare(exported(result.document, (result.data as RouteData).lineId))).toBe(bare(exported(blinded.document, lineId)));
  });

  it('a closed start on a spec without cap rows is the RTE refusal, nothing changed', () => {
    expectRefusal(base, 'import_pcf', { text: capsFile, as: 'route', spec: 'CS150' }, 'RTE_SPEC_NO_COMPONENT');
  });
});

describe('a reducer inside a branch run', () => {
  const created = ok(cs150Document(), 'create_pipeline', { service: 'P', sequence: '3003', spec: 'CS150', dn: 150 });
  const lineId = created.affected[0] as string;
  const header = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 6000 }] });
  const branch = ok(header.document, 'add_branch', {
    runId: header.affected[0],
    at: { point: [3000, 0, 0] },
    dn: 150,
    legs: [{ direction: '+Y', length: 3000 }],
  });
  const withReducer = ok(branch.document, 'insert_inline_component', {
    runId: branch.affected[0],
    type: 'reducerConcentric',
    dn2: 100,
    at: { leg: 0, centreDistance: 1500 },
  });
  const original = exported(withReducer.document, lineId);

  it('the branch is routed at the header size and the reducer inserted after it: same PCF (fixed point), branch reducer listed, pipe delta 0', () => {
    const result = route(original);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs.map((run) => run.inline.map((item) => item.type))).toEqual([[], ['reducer']]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(info.route.comparison.countDelta).toEqual({});
    expect(bare(exported(result.document, info.lineId))).toBe(bare(original));
  });

  it('a branch whose reduced end is a flanged port cannot be routed (add_branch takes the port size): refused naming the reducer, nothing changed', () => {
    const text = original.replace(
      /(PIPE\n(?: {4}.*\n)*? {4}END-POINT 3000.0 3000.0 0.0 100 BW\n)/,
      '$1' + 'FLANGE\n    COMPONENT-IDENTIFIER 90\n    END-POINT 3000.0 3000.0 0.0 100 BW\n    END-POINT 3000.0 3076.0 0.0 100 FL\n',
    );
    expect(text).toContain('COMPONENT-IDENTIFIER 90');
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.summary).toContain('reduced size');
    expect(result.document).toBe(base);
  });
});

describe('an instrument with a tapping point', () => {
  it('a welded INSTRUMENT with a BRANCH1-POINT is refused naming the instrument (the RTE cannot branch off a body), document unchanged', () => {
    const text = hand100(
      record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1300.0 0.0 0.0 100 BW'], '    BRANCH1-POINT 1150.0 200.0 0.0 25 BW\n'),
      '1300.0',
    );
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.summary).toContain('tapping point');
    expect(result.error?.ids).toEqual(['pcf:E-1:2']);
    expect(result.document).toBe(base);
  });

  it('the same instrument without the tapping point is rebuilt', () => {
    const text = hand100(record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1300.0 0.0 0.0 100 BW']), '1300.0');
    expect(route(text).rejected).toBeUndefined();
  });
});

describe('a reducer inside a branch run that ends in a cap', () => {
  const extras = extrasDocument();
  const created = ok(extras, 'create_pipeline', { service: 'P', sequence: '3005', spec: 'CS150', dn: 150 });
  const lineId = created.affected[0] as string;
  const header = ok(created.document, 'route_pipe', { lineId, from: { point: [0, 0, 0] }, legs: [{ direction: '+X', length: 6000 }] });
  const branch = ok(header.document, 'add_branch', {
    runId: header.affected[0],
    at: { point: [3000, 0, 0] },
    dn: 150,
    legs: [{ direction: '+Y', length: 3000 }],
  });
  const reduced = ok(branch.document, 'insert_inline_component', {
    runId: branch.affected[0],
    type: 'reducerConcentric',
    dn2: 100,
    at: { leg: 0, centreDistance: 1500 },
  });
  const capped = ok(reduced.document, 'set_run_end_cap', { runId: branch.affected[0], end: 'end' });
  const original = exported(capped.document, lineId);

  it('the cap is placed after the reducer: export, import as route, export is a fixed point and the branch ends capped at the DN100 size', () => {
    expect(original).toContain('CAP\n');
    const result = route(original, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs.map((run) => [run.inline.map((item) => item.type), run.capped])).toEqual([
      [[], false],
      [['reducer'], true],
    ]);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(bare(exported(result.document, info.lineId))).toBe(bare(original));
  });
});

/** DN100 line: pipe 0..1000, then `middle`, then pipe to 3000 (hand-written, butt weld ends). */
const hand100 = (middle: string, pipeAfterFrom: string): string =>
  HEADER +
  record('PIPE', 1, ['0.0 0.0 0.0 100 BW', '1000.0 0.0 0.0 100 BW']) +
  middle +
  record('PIPE', 9, [`${pipeAfterFrom} 0.0 0.0 100 BW`, '3000.0 0.0 0.0 100 BW']);

describe('flanged joints and instruments in route mode', () => {
  const line = cs150Line(100, '3001');
  const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 100 });
  const routed = ok(tie.doc, 'route_pipe', {
    lineId: line.lineId,
    from: { portId: tie.id },
    to: undefined,
    legs: [{ direction: '+X', length: 4000 }],
    inline: [
      { type: 'flangedJoint', at: { leg: 0, centreDistance: 1500 } },
      { type: 'instrument', lengthMm: 300, at: { leg: 0, centreDistance: 3000 } },
    ],
  });
  const original = exported(routed.document, line.lineId);

  it('a flange - gasket - flange joint and a flanged instrument come back as inline parts: the same file, delta 0, flat counts', () => {
    const result = route(original);
    expect(result.rejected, result.summary).toBeUndefined();
    const info = routeData(result);
    expect(info.route.runs[0]?.inline.map((item) => item.type)).toEqual(['flangedJoint', 'instrument']);
    expect(info.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(info.route.comparison.countDelta).toEqual({});
    expect(firstRun(result.document)?.inline).toEqual([
      expect.objectContaining({ type: 'flangedJoint', centreDistance: 1500 }),
      expect.objectContaining({ type: 'instrument', centreDistance: 3000, lengthMm: 300, endType: 'FL' }),
    ]);
  });

  it('is a fixed point: export, import as route, export again gives the same PCF up to the part ids', () => {
    const first = route(original);
    expect(bare(exported(first.document, routeData(first).lineId))).toBe(bare(original));
  });

  it('a flange pair without a gasket is one joint rebuilt with the spec gasket (3 mm): accepted, the difference reported', () => {
    const text = hand100(
      record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1076.0 0.0 0.0 100 FL'], '    SKEY FLWN\n') +
        record('FLANGE', 3, ['1076.0 0.0 0.0 100 FL', '1152.0 0.0 0.0 100 BW'], '    SKEY FLWN\n'),
      '1152.0',
    );
    const result = route(text);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.inline.map((item) => item.type)).toEqual(['flangedJoint']);
    expect(routeData(result).warnings.map((warning) => warning.code)).toContain('ISO_ROUTE_DIMENSIONS_CHANGED');
  });

  it('a butt-welded instrument (BW ends) is an inline instrument with endType BW', () => {
    const text = hand100(record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW', '1300.0 0.0 0.0 100 BW']), '1300.0');
    const result = route(text);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(firstRun(result.document)?.inline[0]).toMatchObject({ type: 'instrument', lengthMm: 300, endType: 'BW' });
  });

  it('a flanged instrument that is not between two flanges, an instrument with one END-POINT, and a flange joined to an elbow are refused with the component named', () => {
    const bareFlanged = hand100(record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 FL', '1300.0 0.0 0.0 100 FL']), '1300.0');
    const flanged = expectRefusal(base, 'import_pcf', { text: bareFlanged, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(flanged.summary).toContain('instrument');
    expect(flanged.error?.ids).toEqual(['pcf:E-1:2']);
    const single = hand100(record('INSTRUMENT', 2, ['1000.0 0.0 0.0 100 BW']), '1300.0');
    expectRefusal(base, 'import_pcf', { text: single, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    const toElbow = hand100(
      record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1076.0 0.0 0.0 100 FL']) +
        record('GASKET', 3, ['1076.0 0.0 0.0 100 FL', '1079.0 0.0 0.0 100 FL']) +
        record('ELBOW', 4, ['1079.0 0.0 0.0 100 FL', '1231.0 152.0 0.0 100 BW'], '    CENTRE-POINT 1231.0 0.0 0.0\n'),
      '1079.0',
    );
    const elbow = expectRefusal(base, 'import_pcf', { text: toElbow, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(elbow.summary).toContain('neither a flange, a valve nor an instrument');
  });

  it('a flanged instrument between flange sets whose far flange is missing is refused naming the instrument', () => {
    const text = hand100(
      record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1076.0 0.0 0.0 100 FL']) +
        record('INSTRUMENT', 3, ['1076.0 0.0 0.0 100 FL', '1376.0 0.0 0.0 100 FL']),
      '1376.0',
    );
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.summary).toContain('has no flange on its far side');
  });
});

describe('review follow-ups of ISO M6c', () => {
  it('an eccentric reducer whose measured offset is not (OD big - OD small) / 2 is refused ISO_PARAM_INVALID naming it (6 x 4 with 40 mm, not 27)', () => {
    const text =
      HEADER +
      record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '1930.0 0.0 0.0 150 BW']) +
      record('REDUCER-ECCENTRIC', 2, ['1930.0 0.0 0.0 150 BW', '2070.0 0.0 40.0 100 BW']) +
      record('PIPE', 3, ['2070.0 0.0 40.0 100 BW', '3848.0 0.0 40.0 100 BW']) +
      record('ELBOW', 4, ['3848.0 0.0 40.0 100 BW', '4000.0 0.0 192.0 100 BW'], '    CENTRE-POINT 4000.0 0.0 40.0\n') +
      record('PIPE', 5, ['4000.0 0.0 192.0 100 BW', '4000.0 0.0 1000.0 100 BW']);
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_PARAM_INVALID');
    expect(result.error?.ids).toEqual(['pcf:E-1:2']);
    expect(result.summary).toContain('27');
  });

  it('an instrument with socket-weld or threaded ends is refused, not turned into a butt-weld one', () => {
    for (const end of ['SW', 'THD']) {
      const text = hand100(record('INSTRUMENT', 2, [`1000.0 0.0 0.0 100 ${end}`, `1300.0 0.0 0.0 100 ${end}`]), '1300.0');
      const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
      expect(result.error?.ids).toEqual(['pcf:E-1:2']);
      expect(result.summary).toContain(end);
    }
  });

  it('flanged joints drawn without a gasket give ISO_ROUTE_GASKET_ADDED listing the components (flange pair, flanged instrument)', () => {
    const pair = hand100(
      record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1076.0 0.0 0.0 100 FL']) +
        record('FLANGE', 3, ['1076.0 0.0 0.0 100 FL', '1152.0 0.0 0.0 100 BW']),
      '1152.0',
    );
    const paired = routeData(route(pair));
    const added = paired.warnings.find((warning) => warning.code === 'ISO_ROUTE_GASKET_ADDED');
    expect(added?.ids).toEqual(['pcf:E-1:2', 'pcf:E-1:3']);
    const instrumentSet = hand100(
      record('FLANGE', 2, ['1000.0 0.0 0.0 100 BW', '1076.0 0.0 0.0 100 FL']) +
        record('INSTRUMENT', 3, ['1076.0 0.0 0.0 100 FL', '1376.0 0.0 0.0 100 FL']) +
        record('FLANGE', 4, ['1376.0 0.0 0.0 100 FL', '1452.0 0.0 0.0 100 BW']),
      '1452.0',
    );
    const result = route(instrumentSet);
    expect(result.rejected, result.summary).toBeUndefined();
    const ids = routeData(result).warnings.find((warning) => warning.code === 'ISO_ROUTE_GASKET_ADDED')?.ids;
    expect(ids).toEqual(['pcf:E-1:2', 'pcf:E-1:3', 'pcf:E-1:4']);
  });

  it('a file with its gaskets has no ISO_ROUTE_GASKET_ADDED', () => {
    const line = cs150Line(100, '3009');
    const tie = addTie(line.doc, 'A', [0, 0, 0], [1, 0, 0], { dn: 100 });
    const joined = ok(tie.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: tie.id },
      legs: [{ direction: '+X', length: 4000 }],
      inline: [{ type: 'flangedJoint', at: { leg: 0, centreDistance: 1500 } }],
    });
    expect(routeData(route(exported(joined.document, line.lineId))).warnings.map((warning) => warning.code)).not.toContain(
      'ISO_ROUTE_GASKET_ADDED',
    );
  });

  it('a cap right after an elbow (no pipe between) is still placed: the probe learns the spec length, the cap sits at the file joint', () => {
    const extras = extrasDocument();
    const text =
      HEADER +
      record('PIPE', 1, ['0.0 0.0 0.0 100 BW', '2848.0 0.0 0.0 100 BW']) +
      record('ELBOW', 2, ['2848.0 0.0 0.0 100 BW', '3000.0 152.0 0.0 100 BW'], '    CENTRE-POINT 3000.0 0.0 0.0\n    SKEY ELBW\n') +
      record('CAP', 3, ['3000.0 152.0 0.0 100 BW']);
    const result = route(text, {}, extras);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(routeData(result).route.runs[0]?.points.at(-1)).toEqual([3000, 152 + CAP_LENGTH_MM, 0]);
    expect(firstRun(result.document)?.end.cap).toBe(true);
  });
});
