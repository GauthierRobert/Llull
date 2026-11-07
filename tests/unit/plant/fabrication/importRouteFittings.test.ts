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
import { CAP_LENGTH_MM, extrasDocument } from './routeExtraFixtures';

const exported = (doc: CadDocument, lineId: string): string =>
  (data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [lineId] }).files[0] as { content: string }).content;
/** The PCF of a line without the llull part ids (they carry the run id, which a different history gives another number). */
const bare = (text: string): string => text.replace(/^ {4}UNIQUE-COMPONENT-IDENTIFIER .*\n/gm, '');

interface RouteData {
  lineId: string;
  warnings: Array<{ code: string }>;
  route: {
    runs: Array<{ points: number[][]; capped: boolean; inline: Array<{ type: string; eccentric?: boolean }> }>;
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

  it('a tee downstream of the reducer on the same leg is refused with the tee named', () => {
    const text =
      HEADER +
      record('PIPE', 1, ['0.0 0.0 0.0 150 BW', '1930.0 0.0 0.0 150 BW']) +
      record('REDUCER-ECCENTRIC', 2, ['1930.0 0.0 0.0 150 BW', '2070.0 0.0 27.0 100 BW']) +
      record(
        'TEE',
        3,
        ['2070.0 0.0 27.0 100 BW', '2500.0 0.0 27.0 100 BW'],
        '    CENTRE-POINT 2285.0 0.0 27.0\n    BRANCH1-POINT 2285.0 200.0 27.0 100 BW\n',
      );
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.error?.ids).toEqual(['pcf:E-1:3']);
    expect(result.summary).toContain('eccentric reducer');
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
