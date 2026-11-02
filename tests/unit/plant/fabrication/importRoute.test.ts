/**
 * Plant 05 ISO M5: `import_pcf as route` - an imported PCF line becomes a routed line through the 02 RTE commands (VC-ISO-04, SC-ISO-02): closed-form pipe length against
 * the catalogue take-outs, round trips of llull's own PCF (valve set, olet, reducer, supports), refusals with the document unchanged, purity and replay.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { addTie, cs150Document, cs150Line } from '../piping/rteFixtures';
import { fixturePcf } from './fabricationFixtures';

interface RouteData {
  lineId: string;
  lineNumber: string;
  stored: boolean;
  warnings: Array<{ code: string }>;
  route: {
    spec: string;
    runs: Array<{
      key: string;
      runId: string | null;
      dn: number;
      parent: string | null;
      points: number[][];
      startPort: boolean;
      endPort: boolean;
      inline: Array<{ type: string }>;
    }>;
    portIds: string[];
    fieldWelds: Array<{ kind: string; weldId: string | null }>;
    supports: { requested: number; placed: string[]; dropped: number };
    comparison: {
      imported: { countsByType: Record<string, number>; totalPipeLengthMm: number };
      routed: { countsByType: Record<string, number>; totalPipeLengthMm: number };
      pipeLengthDeltaMm: number;
      countDelta: Record<string, number>;
    };
    commands: string[];
  };
}

const routeImport = (doc: CadDocument, text: string, extra: Record<string, unknown> = {}): CommandResult =>
  execute(doc, 'import_pcf', { text, as: 'route', spec: 'CS150', ...extra });

/** The PCF of a line without the llull part ids (they carry the run id, which a different history gives another number). */
const bare = (text: string): string => text.replace(/^ {4}UNIQUE-COMPONENT-IDENTIFIER .*\n/gm, '');

const exported = (doc: CadDocument, lineId: string, extra: Record<string, unknown> = {}): string =>
  (data<{ files: Array<{ content: string }> }>(doc, 'export_pcf', { lineIds: [lineId], ...extra }).files[0] as { content: string }).content;

/** A routed DN100 line from a flanged port with a gate valve; with `reducer` it ends open after a DN80 reducer, else at a second flanged port. */
function valveLine(options: { reducer?: boolean } = {}): { doc: CadDocument; lineId: string } {
  const line = cs150Line(100, '8001');
  const a = addTie(line.doc, 'VA', [0, 0, 1000], [1, 0, 0], { endType: 'FL' });
  const b = addTie(a.doc, 'VB', [7000, 0, 1000], [-1, 0, 0], { endType: 'FL' });
  const inline = [{ type: 'valveGate', at: { leg: 0, centreDistance: 1500 }, stemDirection: [0, 0, 1] }];
  const doc = apply(
    b.doc,
    'route_pipe',
    options.reducer === true
      ? {
          lineId: line.lineId,
          from: { portId: a.id },
          legs: [{ direction: '+X', length: 7000 }],
          inline: [...inline, { type: 'reducerConcentric', dn2: 80, at: { leg: 0, centreDistance: 5000 } }],
        }
      : { lineId: line.lineId, from: { portId: a.id }, to: { portId: b.id }, legs: [{ direction: '+X', length: 3000 }], inline },
  );
  return { doc, lineId: line.lineId };
}

describe('the pack line as a routed line (VC-ISO-04, SC-ISO-02)', () => {
  const base = cs150Document();
  const result = routeImport(base, fixturePcf());
  const routed = result.data as RouteData;

  it('rebuilds the same topology: 3 flanges, 7 pipes, 3 elbows, 1 tee, the site weld; the spec adds 3 gaskets and 3 bolt sets', () => {
    expect(result.rejected).toBeUndefined();
    expect(routed.stored).toBe(true);
    expect(routed.route.comparison.imported.countsByType).toEqual({ FLANGE: 3, PIPE: 7, WELD: 1, ELBOW: 3, TEE: 1 });
    expect(routed.route.comparison.routed.countsByType).toEqual({ GASKET: 3, BOLT: 3, FLANGE: 3, PIPE: 7, WELD: 1, ELBOW: 3, TEE: 1 });
    expect(routed.route.comparison.countDelta).toEqual({});
  });

  it('pipe length = 14500 route - take-outs from the catalogue: 6 x 152 + 3 x (76 + 3 gasket) + 2 x 105 + 105 = 1464, so 13036 mm', () => {
    const routeLength = 5000 + 4000 + 2000 + 3000 + 500;
    const takeOut = 6 * 152 + 3 * (76 + 3) + 2 * 105 + 105;
    expect(routeLength).toBe(14500);
    expect(takeOut).toBe(1464);
    expect(Math.abs(routed.route.comparison.routed.totalPipeLengthMm - (routeLength - takeOut))).toBeLessThan(1e-6);
    const preview = data<{ totalPipeLengthMm: number }>(
      apply(base, 'import_pcf', { text: exported(result.document, routed.lineId) }),
      'export_pcf',
      {},
    );
    expect(preview).toBeDefined();
  });

  it('the difference to the file is the 3 gaskets of 3 mm (the file draws the flange alone), and it is reported, not hidden', () => {
    expect(routed.route.comparison.pipeLengthDeltaMm).toBe(-9);
    expect(routed.warnings.map((warning) => warning.code)).toEqual(['ISO_ROUTE_DIMENSIONS_CHANGED']);
  });

  it('is made of RTE commands only: tie-ins for the 3 flanged ends, create_pipeline, route_pipe, add_branch, add_field_weld', () => {
    expect(routed.route.commands).toEqual([
      'create_pipeline',
      'add_tie_in_point',
      'add_tie_in_point',
      'route_pipe',
      'add_tie_in_point',
      'add_branch',
      'add_field_weld',
    ]);
    expect(routed.route.portIds).toHaveLength(3);
    expect(routed.route.runs.map((run) => [run.key, run.parent, run.startPort, run.endPort])).toEqual([
      ['main', null, true, true],
      ['branch-1', 'main', false, true],
    ]);
    const piping = result.document.plant?.piping;
    expect(Object.keys(piping?.runs ?? {})).toHaveLength(2);
    expect(piping?.lines[routed.lineId]?.lineNumber).toBe('L-101');
    expect(result.affected[0]).toBe(routed.lineId);
    expect(result.document.plant?.fabrication?.fieldWelds).toBeDefined();
    expect(result.document.plant?.fabrication?.pcfLines ?? {}).toEqual({});
  });

  it('the field weld lands on the same point as in the file (2500, 0, 3000) and is a site weld', () => {
    const fieldWelds = Object.values(result.document.plant?.fabrication?.fieldWelds ?? {});
    expect(fieldWelds.map((weld) => [weld.type, ...weld.xyz])).toEqual([['site', 2500, 0, 3000]]);
  });

  it('export_pcf of the routed line, imported again as route, gives the same line (no dimension change: a fixed point)', () => {
    const text = exported(result.document, routed.lineId);
    const again = routeImport(base, text, { spec: 'CS150' });
    const second = again.data as RouteData;
    expect(second.route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(second.route.comparison.countDelta).toEqual({});
    expect(second.route.comparison.routed.countsByType).toEqual(routed.route.comparison.routed.countsByType);
    expect(second.warnings).toEqual([]);
    expect(exported(again.document, second.lineId)).toBe(text);
  });

  it('the routed line is editable: the pcf_line stays untouched and the document validates after save/load of the slice', () => {
    expect(ok(result.document, 'check_piping', {}).rejected).toBeUndefined();
    const welds = data<{ welds: unknown[] }>(result.document, 'weld_list', { lineId: routed.lineId });
    expect(welds.welds).toHaveLength(13);
  });

  it('preview as route builds on a scratch document: nothing is stored, the plan and comparison are reported', () => {
    const previewed = routeImport(base, fixturePcf(), { preview: true });
    expect(previewed.document).toBe(base);
    expect(previewed.affected).toEqual([]);
    const preview = previewed.data as RouteData;
    expect(preview.stored).toBe(false);
    expect(preview.lineId).toBe('L-101');
    expect(preview.route.comparison.routed.totalPipeLengthMm).toBe(13036);
  });

  it('is pure, deterministic, and replay_history re-mints identical ids', () => {
    const before = JSON.stringify(base);
    const again = routeImport(base, fixturePcf());
    expect(JSON.stringify(base)).toBe(before);
    expect(JSON.stringify(again.document.plant)).toBe(JSON.stringify(result.document.plant));
    expect(again.affected).toEqual(result.affected);
    const replayed = execute(result.document, 'replay_history', {}).document;
    expect(replayed.plant).toEqual(result.document.plant);
  });
});

describe("inline components, olets and reducers rebuilt from llull's own PCF", () => {
  it('a gate valve set (flange, gasket, valve, gasket, flange) becomes one inline valve; the line is a fixed point', () => {
    const { doc, lineId } = valveLine();
    const text = exported(doc, lineId);
    expect(text).toContain('VALVE');
    const imported = routeImport(cs150Document(), text);
    const route = (imported.data as RouteData).route;
    expect(route.runs[0]?.inline.map((item) => item.type)).toEqual(['valve']);
    expect(route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(route.comparison.countDelta).toEqual({});
    expect(bare(exported(imported.document, (imported.data as RouteData).lineId))).toBe(bare(text));
  });

  it('a concentric reducer keeps its outlet size and the end port the size after it', () => {
    const { doc, lineId } = valveLine({ reducer: true });
    const text = exported(doc, lineId);
    const imported = routeImport(cs150Document(), text);
    expect(imported.rejected, imported.summary).toBeUndefined();
    const route = (imported.data as RouteData).route;
    expect(route.runs[0]?.inline.map((item) => item.type)).toEqual(['valve', 'reducer']);
    expect(route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(bare(exported(imported.document, (imported.data as RouteData).lineId))).toBe(bare(text));
  });

  it('an olet becomes a branch off the run that carries it (the spec table decides the fitting)', () => {
    const line = cs150Line(150, '8002');
    const a = addTie(line.doc, 'OA', [0, 0, 1000], [1, 0, 0], { endType: 'BW', dn: 150 });
    let doc = apply(a.doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 5000 }] });
    const runId = doc.plant?.piping?.runOrder[0] as string;
    doc = apply(doc, 'add_branch', { runId, at: { point: [2500, 0, 1000] }, dn: 50, legs: [{ direction: '+Y', length: 800 }] });
    const text = exported(doc, line.lineId);
    expect(text).toContain('OLET');
    const imported = routeImport(cs150Document(), text);
    expect(imported.rejected, imported.summary).toBeUndefined();
    const route = (imported.data as RouteData).route;
    expect(route.runs.map((run) => [run.key, run.parent, run.dn])).toEqual([
      ['main', null, 150],
      ['branch-1', 'main', 50],
    ]);
    expect(route.comparison.pipeLengthDeltaMm).toBe(0);
    expect(bare(exported(imported.document, (imported.data as RouteData).lineId))).toBe(bare(text));
  });
});

describe('supports of the file', () => {
  function supported(): { text: string; lineId: string } {
    const line = cs150Line(100, '8003');
    const a = addTie(line.doc, 'SA', [0, 0, 1000], [1, 0, 0], { endType: 'BW' });
    let doc = apply(a.doc, 'add_level', { name: 'Grade', elevation: 0 });
    doc = apply(doc, 'route_pipe', { lineId: line.lineId, from: { portId: a.id }, legs: [{ direction: '+X', length: 6000 }] });
    doc = apply(doc, 'add_pipe_support', {
      runId: doc.plant?.piping?.runOrder[0],
      at: [
        [2000, 0, 1000],
        [4000, 0, 1000],
      ],
      type: 'guide',
    });
    return { text: exported(doc, line.lineId, { includeSupports: true }), lineId: line.lineId };
  }

  it('SUPPORT records are placed with add_pipe_support (type from SUPPORT-TYPE) on the new run', () => {
    const { text } = supported();
    expect(text.match(/^SUPPORT$/gm)).toHaveLength(2);
    const base = apply(cs150Document(), 'add_level', { name: 'Grade', elevation: 0 });
    const imported = routeImport(base, text);
    expect(imported.rejected, imported.summary).toBeUndefined();
    const route = (imported.data as RouteData).route;
    expect(route.supports).toMatchObject({ requested: 2, dropped: 0 });
    expect(route.supports.placed).toHaveLength(2);
    const types = Object.values(imported.document.building?.elements ?? {}).flatMap((element) =>
      element.category === 'pipeSupport' ? [element.type] : [],
    );
    expect(types).toEqual(['guide', 'guide']);
    expect(bare(exported(imported.document, (imported.data as RouteData).lineId, { includeSupports: true }))).toBe(bare(text));
  });

  it('without a building level the supports cannot be placed: ISO_ROUTE_NO_LEVEL, or supports false drops them with a warning', () => {
    const { text } = supported();
    const base = cs150Document();
    expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_NO_LEVEL', 'supports');
    const dropped = routeImport(base, text, { supports: false });
    const route = dropped.data as RouteData;
    expect(route.route.supports).toMatchObject({ requested: 2, placed: [], dropped: 2 });
    expect(route.warnings.map((warning) => warning.code)).toContain('ISO_ROUTE_SUPPORTS_DROPPED');
  });

  it('a support that lies on no pipe makes add_pipe_support fail and the whole import is refused, document unchanged', () => {
    const { text } = supported();
    const moved = text.replace(/CO-ORDS 2000\.0 0\.0 1000\.0/, 'CO-ORDS 2000.0 5000.0 9000.0');
    const base = apply(cs150Document(), 'add_level', { name: 'Grade', elevation: 0 });
    const result = routeImport(base, moved);
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(base);
    expect(result.affected).toEqual([]);
  });
});

describe('refusals leave the document unchanged', () => {
  const base = cs150Document();

  it('no spec: the file names none and none is given (ISO_ROUTE_SPEC_MISSING)', () => {
    const text = fixturePcf().replace('    PIPING-SPEC A1A\n', '');
    expectRefusal(base, 'import_pcf', { text, as: 'route' }, 'ISO_ROUTE_SPEC_MISSING', 'spec');
  });

  it('a spec that is not in the document passes the RTE refusal through; no tie-in or line is left behind', () => {
    const result = expectRefusal(base, 'import_pcf', { text: fixturePcf(), as: 'route' }, 'RTE_SPEC_UNKNOWN');
    expect(result.summary).toContain('create_pipeline');
    expect(result.document.plant?.piping?.tieInOrder ?? []).toEqual([]);
  });

  it('a failure half way (a size the spec has no pipe row for) leaves nothing, whatever steps ran before', () => {
    const text = fixturePcf().replaceAll(' 100 BW', ' 900 BW').replaceAll(' 100 FL', ' 900 FL');
    const result = routeImport(base, text);
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(base);
  });

  it('a line id in use is ISO_PCF_LINE_EXISTS, as for pcf_line', () => {
    const first = routeImport(base, fixturePcf());
    expectRefusal(first.document, 'import_pcf', { text: fixturePcf(), as: 'route', spec: 'CS150' }, 'ISO_PCF_LINE_EXISTS');
    const renamed = routeImport(first.document, fixturePcf(), { lineIdOverride: 'L-102' });
    expect(renamed.rejected).toBeUndefined();
    expect((renamed.data as RouteData).lineNumber).toBe('L-102');
  });

  it('components route mode cannot rebuild are named: cap, blind flange, instrument, eccentric reducer', () => {
    for (const [type, words] of [
      ['CAP', 'a cap'],
      ['FLANGE-BLIND', 'a blind flange'],
      ['INSTRUMENT', 'an instrument'],
      ['REDUCER-ECCENTRIC', 'an eccentric reducer'],
    ] as const) {
      const text = fixturePcf().replace(
        'MATERIALS\n',
        `${type}\n    COMPONENT-IDENTIFIER 16\n    END-POINT 8000.0 4000.0 1000.0 100 FL\n    END-POINT 8100.0 4000.0 1000.0 100 FL\nMATERIALS\n`,
      );
      const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED', 'as');
      expect(result.summary).toContain(words);
      expect(result.error?.ids).toEqual(['pcf:L-101:16']);
    }
  });

  it('a flanged joint that is not a valve set is refused with the flange named', () => {
    const text = fixturePcf()
      .replace(
        'PIPE\n    COMPONENT-IDENTIFIER 4\n',
        'FLANGE\n    COMPONENT-IDENTIFIER 90\n    END-POINT 2500.0 0.0 3000.0 100 BW\n    END-POINT 2576.0 0.0 3000.0 100 FL\n    SKEY FLWN\n    ITEM-CODE FLWN-100-150\nFLANGE\n    COMPONENT-IDENTIFIER 91\n    END-POINT 2576.0 0.0 3000.0 100 FL\n    END-POINT 2652.0 0.0 3000.0 100 BW\n    SKEY FLWN\n    ITEM-CODE FLWN-100-150\nPIPE\n    COMPONENT-IDENTIFIER 4\n',
      )
      .replace(
        '    END-POINT 2500.0 0.0 3000.0 100 BW\n    END-POINT 4848.0',
        '    END-POINT 2652.0 0.0 3000.0 100 BW\n    END-POINT 4848.0',
      );
    const result = expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.summary).toContain('flange');
  });

  it('components not connected to the line start, and a closed loop, are refused', () => {
    const stray = fixturePcf().replace(
      'MATERIALS\n',
      'PIPE\n    COMPONENT-IDENTIFIER 16\n    END-POINT 9000.0 0.0 0.0 100 BW\n    END-POINT 9500.0 0.0 0.0 100 BW\nMATERIALS\n',
    );
    const result = expectRefusal(base, 'import_pcf', { text: stray, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED');
    expect(result.error?.ids).toEqual(['pcf:L-101:16']);
    const loop =
      'ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE LOOP\n    PIPING-SPEC CS150\n' +
      [
        [
          [0, 0, 0],
          [1000, 0, 0],
        ],
        [
          [1000, 0, 0],
          [1000, 1000, 0],
        ],
        [
          [1000, 1000, 0],
          [0, 1000, 0],
        ],
        [
          [0, 1000, 0],
          [0, 0, 0],
        ],
      ]
        .map(
          ([a, b], k) =>
            `PIPE\n    COMPONENT-IDENTIFIER ${k + 1}\n    END-POINT ${a?.join(' ')} 100 BW\n    END-POINT ${b?.join(' ')} 100 BW\n`,
        )
        .join('');
    expectRefusal(base, 'import_pcf', { text: loop, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_UNSUPPORTED', 'as');
  });

  it('a line over 400 components is ISO_ROUTE_TOO_LARGE', () => {
    const pipes = Array.from(
      { length: 401 },
      (_unused, k) =>
        `PIPE\n    COMPONENT-IDENTIFIER ${k + 1}\n    END-POINT ${k * 100}.0 0.0 0.0 100 BW\n    END-POINT ${k * 100 + 100}.0 0.0 0.0 100 BW\n`,
    ).join('');
    const text = `ISOGEN-FILES ISOGEN.FLS\nUNITS-BORE MM\nUNITS-CO-ORDS MM\nPIPELINE-REFERENCE BIG\n    PIPING-SPEC CS150\n${pipes}`;
    expectRefusal(base, 'import_pcf', { text, as: 'route', spec: 'CS150' }, 'ISO_ROUTE_TOO_LARGE', 'as');
  });

  it('route-only parameters with pcf_line are ISO_PARAM_INVALID; a document not in mm is refused by the RTE', () => {
    expectRefusal(base, 'import_pcf', { text: fixturePcf(), spec: 'CS150' }, 'ISO_PARAM_INVALID', 'spec');
    expectRefusal(base, 'import_pcf', { text: fixturePcf(), as: 'pcf_line', supports: false }, 'ISO_PARAM_INVALID', 'supports');
    const metres = apply(createEmptyDocument(), 'set_units', { units: 'm' });
    const result = routeImport(metres, fixturePcf());
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(metres);
  });

  it('pcf_line (the default) is unchanged by route mode: a stored line exports back to the same bytes', () => {
    const stored = apply(base, 'import_pcf', { text: fixturePcf() });
    expect(exported(stored, 'L-101')).toBe(fixturePcf());
  });
});
