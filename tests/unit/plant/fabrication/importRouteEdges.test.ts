/**
 * Plant 05 ISO M5: `import_pcf as route` on files other tools write (hand-built PCF text): elbows without a centre point, a welded valve, field-fit welds, bends, branches
 * that cannot be rebuilt, and the routed result of a file whose dimensions are not the spec's.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';

const HEADER = 'ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE E-1\n    PIPING-SPEC CS150\n';

const pipe = (id: number, a: string, b: string, bore = 100): string =>
  `PIPE\n    COMPONENT-IDENTIFIER ${id}\n    END-POINT ${a} ${bore} BW\n    END-POINT ${b} ${bore} BW\n`;

const base = cs150Document();
const route = (body: string, extra: Record<string, unknown> = {}): CommandResult =>
  execute(base, 'import_pcf', { text: HEADER + body, as: 'route', spec: 'CS150', ...extra });
interface RouteInfo {
  route: { comparison: { pipeLengthDeltaMm: number } };
  warnings: Array<{ code: string }>;
}
const routeData = (body: string): RouteInfo => route(body).data as RouteInfo;

describe('files written by other tools', () => {
  it('an elbow without CENTRE-POINT takes the corner of the L through its end points', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'ELBOW\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1152.0 152.0 0.0 100 BW\n    SKEY ELBW\n' +
      pipe(3, '1152.0 152.0 0.0', '1152.0 2000.0 0.0');
    const result = route(body);
    expect(result.rejected, result.summary).toBeUndefined();
    const runs = (result.data as { route: { runs: Array<{ points: number[][] }> } }).route.runs;
    expect(runs[0]?.points).toEqual([
      [0, 0, 0],
      [1152, 0, 0],
      [1152, 2000, 0],
    ]);
  });

  it('a welded valve (BW ends, no flanges) is one inline valve with its spindle direction', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'VALVE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1300.0 0.0 0.0 100 BW\n    SPINDLE-DIRECTION NORTH\n' +
      pipe(3, '1300.0 0.0 0.0', '2500.0 0.0 0.0');
    const result = route(body);
    expect(result.rejected, result.summary).toBeUndefined();
    expect((result.data as { route: { runs: Array<{ inline: Array<{ type: string }> }> } }).route.runs[0]?.inline).toEqual([
      { type: 'valve', componentId: 'pcf:E-1:2' },
    ]);
    const stem = Object.values(result.document.plant?.piping?.runs ?? {})[0]?.inline?.[0]?.stemDirection;
    expect(stem).toEqual([0, 1, 0]);
  });

  it('valveType names the catalogue type of every valve: one the spec does not hold is the RTE refusal, document unchanged', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'VALVE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1300.0 0.0 0.0 100 BW\n' +
      pipe(3, '1300.0 0.0 0.0', '2500.0 0.0 0.0');
    const refused = route(body, { valveType: 'valveGlobe' });
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('RTE_SPEC_NO_COMPONENT');
    expect(refused.document).toBe(base);
  });

  it('a field-fit weld (SKEY WF) and a shop weld (SKEY WW): the first is stored as a field-fit weld, the second is derived', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'WELD\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1000.0 0.0 0.0 100 BW\n    SKEY WF\n    ERECTION-ITEM\n' +
      pipe(3, '1000.0 0.0 0.0', '2000.0 0.0 0.0') +
      'WELD\n    COMPONENT-IDENTIFIER 4\n    END-POINT 2000.0 0.0 0.0 100 BW\n    END-POINT 2000.0 0.0 0.0 100 BW\n    SKEY WW\n' +
      pipe(5, '2000.0 0.0 0.0', '3000.0 0.0 0.0');
    const result = route(body);
    const info = result.data as { route: { fieldWelds: Array<{ kind: string }>; shopWeldsDerived: number } };
    expect(info.route.fieldWelds.map((weld) => weld.kind)).toEqual(['field_fit']);
    expect(info.route.shopWeldsDerived).toBe(1);
    expect(Object.values(result.document.plant?.fabrication?.fieldWelds ?? {}).map((weld) => weld.type)).toEqual(['field_fit']);
  });

  it('a file whose dimensions are not the spec ones is routed on the spec and the change is measured', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'ELBOW\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1100.0 100.0 0.0 100 BW\n    CENTRE-POINT 1100.0 0.0 0.0\n' +
      pipe(3, '1100.0 100.0 0.0', '1100.0 3000.0 0.0');
    const info = routeData(body);
    expect(info.warnings.map((warning) => warning.code)).toEqual(['ISO_ROUTE_DIMENSIONS_CHANGED']);
    expect(info.route.comparison.pipeLengthDeltaMm).toBeCloseTo(-52 - 52, 6);
  });
});

describe('branches', () => {
  it('a tee without a branch point and an olet that lies on no pipe are refused with the component named', () => {
    const tee =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'TEE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1210.0 0.0 0.0 100 BW\n    CENTRE-POINT 1105.0 0.0 0.0\n';
    const refusedTee = expectRefusal(base, 'import_pcf', { text: HEADER + tee, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(refusedTee.error?.ids).toEqual(['pcf:E-1:2']);
    const olet =
      pipe(1, '0.0 0.0 0.0', '2000.0 0.0 0.0') +
      'OLET\n    COMPONENT-IDENTIFIER 2\n    CENTRE-POINT 1000.0 900.0 0.0\n    BRANCH1-POINT 1000.0 950.0 0.0 50 BW\n';
    const refusedOlet = expectRefusal(base, 'import_pcf', { text: HEADER + olet, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(refusedOlet.error?.ids).toEqual(['pcf:E-1:2']);
  });

  it('a reducer inside a branch is refused (the branch end port takes the branch size)', () => {
    const line = cs150Line(100, '9101');
    const a = addTie(line.doc, 'RA', [0, 0, 1000], [1, 0, 0], { endType: 'BW' });
    let doc: CadDocument = apply(a.doc, 'route_pipe', {
      lineId: line.lineId,
      from: { portId: a.id },
      legs: [{ direction: '+X', length: 5000 }],
    });
    const runId = doc.plant?.piping?.runOrder[0] as string;
    doc = apply(doc, 'add_branch', { runId, at: { point: [2500, 0, 1000] }, dn: 100, legs: [{ direction: '+Y', length: 4000 }] });
    const branchRun = doc.plant?.piping?.runOrder[1] as string;
    doc = apply(doc, 'insert_inline_component', {
      runId: branchRun,
      type: 'reducerConcentric',
      dn2: 80,
      at: { leg: 0, centreDistance: 2500 },
    });
    const text = (
      data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [line.lineId] }).files[0] as { content: string }
    ).content;
    expect(text).toContain('REDUCER-CONCENTRIC');
    const result = expectRefusal(cs150Document(), 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.summary).toContain('reducer inside a branch');
  });

  it('a flanged valve without flanges and a valve set missing its far flange are refused', () => {
    const flangedValve =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'VALVE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 FL\n    END-POINT 1230.0 0.0 0.0 100 FL\n' +
      pipe(3, '1230.0 0.0 0.0', '2500.0 0.0 0.0');
    expectRefusal(base, 'import_pcf', { text: HEADER + flangedValve, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    const half =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'FLANGE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1076.0 0.0 0.0 100 FL\n' +
      'GASKET\n    COMPONENT-IDENTIFIER 3\n    END-POINT 1076.0 0.0 0.0 100 FL\n    END-POINT 1079.0 0.0 0.0 100 FL\n' +
      'VALVE\n    COMPONENT-IDENTIFIER 4\n    END-POINT 1079.0 0.0 0.0 100 FL\n    END-POINT 1309.0 0.0 0.0 100 FL\n';
    const refused = expectRefusal(base, 'import_pcf', { text: HEADER + half, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(refused.summary).toContain('no flange on its far side');
  });

  it('a flange joined to a pipe by its flanged face, and a flange that is not a valve-set neighbour, are refused', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'FLANGE\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1076.0 0.0 0.0 100 FL\n' +
      pipe(3, '1076.0 0.0 0.0', '2000.0 0.0 0.0');
    const refused = expectRefusal(base, 'import_pcf', { text: HEADER + body, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(refused.error?.ids).toEqual(['pcf:E-1:2']);
  });
});

describe('a bend and a bent run', () => {
  it('a BEND record is routed through its centre point like an elbow (the spec decides trimmed or bend)', () => {
    const body =
      pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') +
      'BEND\n    COMPONENT-IDENTIFIER 2\n    END-POINT 1000.0 0.0 0.0 100 BW\n    END-POINT 1152.0 152.0 0.0 100 BW\n    CENTRE-POINT 1152.0 0.0 0.0\n' +
      pipe(3, '1152.0 152.0 0.0', '1152.0 2000.0 0.0');
    const result = route(body);
    expect(result.rejected, result.summary).toBeUndefined();
    expect((result.data as { route: { runs: Array<{ points: number[][] }> } }).route.runs[0]?.points).toHaveLength(3);
  });
});

describe('untrusted files never throw and never get past the reader unchecked', () => {
  const attempt = (text: string, extra: Record<string, unknown> = {}): CommandResult =>
    execute(base, 'import_pcf', { text, as: 'route', spec: 'CS150', ...extra });
  const [nul, cr, lf, surrogate] = [0, 13, 10, 0xd800].map((code) => String.fromCharCode(code)) as [string, string, string, string];

  it('non-finite and non-numeric coordinates, a NUL and an empty file are coded refusals; CRLF is a clean import', () => {
    const good = HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0');
    for (const text of [
      HEADER + pipe(1, '0.0 0.0 0.0', '1e309 0.0 0.0'),
      HEADER + pipe(1, '0.0 NaN 0.0', '1000.0 0.0 0.0'),
      HEADER + pipe(1, '0.0 0.0 0.0', 'x y z'),
      '',
      nul,
    ]) {
      const result = attempt(text);
      expect(result.rejected, text.slice(60, 100)).toBe(true);
      expect(result.document).toBe(base);
      expect(result.error?.code).toMatch(/^(ISO_|RTE_|CMD_INVALID_PARAMS)/);
    }
    expect(() => attempt(good.replace('E-1', `E-${surrogate}`))).not.toThrow();
    const lone = attempt(good.replaceAll(lf, cr));
    expect(lone.document === base || lone.rejected === true).toBe(true);
    const crlf = attempt(good.replaceAll(lf, cr + lf));
    expect(crlf.rejected, crlf.summary).toBeUndefined();
  });

  it('a degenerate line (one pipe of zero length, two pipes on one span) is refused, not thrown', () => {
    const zero = attempt(HEADER + pipe(1, '5.0 5.0 5.0', '5.0 5.0 5.0'));
    expect(zero.rejected).toBe(true);
    expect(zero.document).toBe(base);
    const doubled = attempt(HEADER + pipe(1, '0.0 0.0 0.0', '1000.0 0.0 0.0') + pipe(2, '0.0 0.0 0.0', '1000.0 0.0 0.0'));
    expect(doubled.rejected).toBe(true);
    expect(doubled.document).toBe(base);
  });

  it('a file of more than 200000 lines is ISO_PCF_TOO_LARGE before any command runs', () => {
    const text = HEADER + `!${lf}`.repeat(200_001);
    expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_PCF_TOO_LARGE');
  });
});

describe('size and magnitude limits', () => {
  const chain = (count: number): string =>
    HEADER + Array.from({ length: count }, (_unused, k) => pipe(k + 1, `${k * 100}.0 0.0 0.0`, `${k * 100 + 100}.0 0.0 0.0`)).join('');

  it('exactly 400 components are rebuilt; 401 are ISO_ROUTE_TOO_LARGE', () => {
    const ok = execute(base, 'import_pcf', { text: chain(400), as: 'route', spec: 'CS150' });
    expect(ok.rejected, ok.summary).toBeUndefined();
    expect((ok.data as { route: { runs: unknown[] } }).route.runs).toHaveLength(1);
    expectRefusal(base, 'import_pcf', { text: chain(401), as: 'route', spec: 'CS150' }, 'ISO_ROUTE_TOO_LARGE', 'as');
  });

  it('finite but huge coordinates (1e300, a pipe of 1e15 mm) never throw: a coded refusal or a clean import, the document unchanged on refusal', () => {
    for (const far of ['1e300', '1e15', '1e200']) {
      const result = execute(base, 'import_pcf', { text: HEADER + pipe(1, '0.0 0.0 0.0', `${far} 0.0 0.0`), as: 'route', spec: 'CS150' });
      if (result.rejected === true) {
        expect(result.document).toBe(base);
        expect(result.error?.code).toBeDefined();
      } else expect(result.affected.length).toBeGreaterThan(0);
    }
    const stored = execute(base, 'import_pcf', { text: HEADER + pipe(1, '0.0 0.0 0.0', '1e300 0.0 0.0') });
    expect(stored.rejected === true || stored.affected.length > 0).toBe(true);
  });
});
