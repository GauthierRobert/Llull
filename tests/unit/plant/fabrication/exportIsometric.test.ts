/** Plant 05 ISO M3: export_isometric (VC-ISO-10, 11, 12, 17): sheet content, formats, tables, north arrow, refusals, purity, determinism, budget. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { fixturePcf } from './fabricationFixtures';
import { loadedL101 } from './isoM2Fixtures';

interface Exported {
  lineId: string;
  style: string;
  paper: string;
  files: Array<{ name: string; format: string; content: string; sha256: string }>;
  sheets: Array<{ index: number; files: string[]; sha256: string; componentIds: string[]; continuation: Record<string, unknown> }>;
  projection: { axes: Record<'east' | 'north' | 'up', { angleDeg: number }>; interAxisAngleDeg: number; trueIsoScale: number };
  northArrow: { mode: string; angleDeg: number };
  dimensions: Array<{ run: number; values: number[]; overall: number; labels: Array<{ text: string; valueMm: number; exactMm: number }> }>;
  dimensionMismatches: number;
  annotations: Array<{ kind: string; text: string; sheet: number[]; weldKind?: string; numbered?: boolean }>;
  tables: Record<string, { rows: number; columns: string[]; data: string[][] }>;
  layout: { k: number; scale: number; overflow: boolean; passes: number; crossings: number };
  warnings: Array<{ code: string; severity: string }>;
  reviewRequired: boolean;
}

const exported = (doc: CadDocument, params: Record<string, unknown> = {}): Exported =>
  data<Exported>(doc, 'export_isometric', { lineId: 'L-101', ...params });
const grade = (): CadDocument => apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });

describe('the fixture sheet (VC-ISO-10, 11)', () => {
  const doc = loadedL101();
  const result = exported(doc, { style: 'final', formats: ['svg', 'dxf'] });
  const svg = result.files.find((file) => file.format === 'svg')?.content ?? '';
  const dxf = result.files.find((file) => file.format === 'dxf')?.content ?? '';

  it('reports the projection axes, the north arrow, one sheet, reviewRequired', () => {
    expect(result.projection.axes.east.angleDeg).toBeCloseTo(-30, 9);
    expect(result.projection.axes.north.angleDeg).toBeCloseTo(30, 9);
    expect(result.projection.axes.up.angleDeg).toBeCloseTo(90, 9);
    expect(result.projection.interAxisAngleDeg).toBe(120);
    expect(result.projection.trueIsoScale).toBeCloseTo(0.816496580928, 12);
    expect(result.northArrow).toEqual({ mode: 'up_right', angleDeg: result.northArrow.angleDeg });
    expect(result.northArrow.angleDeg).toBeCloseTo(30, 9);
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]?.componentIds).toHaveLength(15);
    expect(result.sheets[0]?.continuation).toEqual({});
    expect(result.reviewRequired).toBe(true);
  });

  it('every dimension label equals its 3D distance; the east string closes to 5000', () => {
    expect(result.dimensionMismatches).toBe(0);
    expect(result.dimensions[0]).toMatchObject({ run: 1, values: [76, 2424, 2348, 152], overall: 5000 });
    for (const dimension of result.dimensions)
      for (const label of dimension.labels) expect(Math.abs(label.valueMm - label.exactMm)).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it('lists elevations, coordinates, the 13 weld marks and the two spools with their sheet position', () => {
    const kinds = (kind: string): string[] =>
      result.annotations.filter((annotation) => annotation.kind === kind).map((annotation) => annotation.text);
    expect(kinds('elevation')).toEqual(expect.arrayContaining(['EL +3000', 'EL +1000', 'EL +1500']));
    expect(kinds('coordinate')).toEqual(expect.arrayContaining(['E 0 N 0', 'E 8000 N 4000']));
    expect(kinds('weld')).toHaveLength(13);
    expect(kinds('spool')).toEqual(['L-101-SP01', 'L-101-SP02']);
    const weld = result.annotations.find((annotation) => annotation.text === 'W2');
    expect(weld).toMatchObject({ weldKind: 'site', numbered: false });
    expect(weld?.sheet).toHaveLength(2);
  });

  it('the svg carries the stamp, the labels and the symbols; the dxf the layers and ends cleanly', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('NOT FOR CONSTRUCTION');
    for (const text of ['>2424<', '>5000<', '>EL +3000<', '>W2<', '>L-101-SP01<', '>BILL OF MATERIAL<']) expect(svg).toContain(text);
    expect(svg).toContain('<polygon');
    expect(svg.match(/<line /g)?.length ?? 0).toBeGreaterThan(40);
    for (const layer of ['ISO-PIPE', 'ISO-SYMB', 'ISO-DIM', 'ISO-TEXT', 'ISO-TABLE', 'ISO-FRAME']) expect(dxf).toContain(layer);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
    expect(dxf).toContain('2424');
  });

  it('style final prints the tables; the cut list is left out with a warning while no weld gap is stored', () => {
    expect(Object.keys(result.tables)).toEqual(['bom', 'weld_list', 'spool_list']);
    expect(result.tables['weld_list']?.rows).toBe(13);
    expect(result.tables['bom']?.data.map((row) => row[0])).toEqual(['FLWN-100-150', 'PIPE-100-S40', 'ELL90LR-100-S40', 'TEE-100-S40']);
    expect(result.tables['spool_list']?.data.map((row) => row[0])).toEqual(['L-101-SP01', 'L-101-SP02']);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['ISO_GAP_UNDEFINED', 'ISO_WELDS_UNNUMBERED']);
  });

  it('with a stored weld gap the cut list is printed with the cut lengths of the cut_list command', () => {
    const ruled = apply(doc, 'set_fabrication_rules', { weldGapMm: 3, source: 'test' });
    const table = exported(ruled, { style: 'final' }).tables['cut_list'];
    expect(table?.rows).toBe(7);
    expect(table?.data.map((row) => row[3])).toEqual(['2421', '2345', '3693', '1693', '1845', '711', '316']);
  });
});

describe('options', () => {
  const doc = loadedL101();

  it('the check style prints no tables unless asked; tables selects them; formats select the files, once each', () => {
    expect(exported(doc).tables).toEqual({});
    expect(Object.keys(exported(doc, { tables: ['weld_list'] }).tables)).toEqual(['weld_list']);
    expect(exported(doc).files.map((file) => file.name)).toEqual(['L-101_iso_sheet1.svg']);
    expect(exported(doc, { formats: ['dxf', 'dxf', 'svg'] }).files.map((file) => file.name)).toEqual([
      'L-101_iso_sheet1.dxf',
      'L-101_iso_sheet1.svg',
    ]);
  });

  it('up_left draws north at 150 degrees; another paper changes the sheet', () => {
    const left = exported(doc, { northArrow: 'up_left' });
    expect(left.projection.axes.north.angleDeg).toBeCloseTo(150, 9);
    expect(left.northArrow).toMatchObject({ mode: 'up_left' });
    expect(left.files[0]?.sha256).not.toBe(exported(doc).files[0]?.sha256);
    const a4 = exported(doc, { paper: 'A4' });
    expect(a4.paper).toBe('A4');
    expect(a4.files[0]?.content).toContain('width="297mm"');
  });

  it('numbered welds are marked as numbered; the field-fit symbol (a circle) appears after set_weld_type', () => {
    const numbered = apply(doc, 'number_welds', { lineId: 'L-101' });
    const result = exported(numbered);
    expect(result.annotations.find((annotation) => annotation.text === 'W2')?.numbered).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).not.toContain('ISO_WELDS_UNNUMBERED');
    const fitted = apply(numbered, 'set_weld_type', { weldId: 'L-101#2', type: 'field_fit' });
    expect(exported(fitted).files[0]?.content).toContain('r="2.2"');
    expect(exported(numbered).files[0]?.content).not.toContain('r="2.2"');
  });
});

describe('VC-ISO-12: a sloped drain', () => {
  const drain = apply(grade(), 'add_pipe_run', {
    points: [
      [0, 0, 1000],
      [10000, 0, 900],
    ],
    dn: 50,
    line: 'D-201',
    service: 'drain',
  });

  it('carries SLOPE 1:100, the fall arrow, and the elevations at both ends', () => {
    const result = exported(drain, { lineId: 'D-201' });
    const slope = result.annotations.find((annotation) => annotation.kind === 'slope');
    expect(slope?.text).toBe('SLOPE 1:100');
    expect(result.files[0]?.content).toContain('>SLOPE 1:100<');
    expect(result.annotations.filter((annotation) => annotation.kind === 'elevation').map((annotation) => annotation.text)).toEqual([
      'EL +1000',
      'EL +900',
    ]);
    expect(result.warnings.map((warning) => warning.code)).toContain('ISO_OPEN_END');
  });
});

describe('legacy and routed sources', () => {
  it('a legacy polyline is drawn with its derived elbows and reports the warning', () => {
    const doc = apply(grade(), 'add_pipe_run', {
      points: [
        [0, 0, 0],
        [5000, 0, 0],
        [5000, 5000, 0],
        [5000, 5000, 3000],
      ],
      dn: 100,
      line: 'L-1',
      service: 'water',
    });
    const result = exported(doc, { lineId: 'L-1' });
    expect(result.warnings.map((warning) => warning.code)).toContain('ISO_LEGACY_FITTINGS_DERIVED');
    expect(result.dimensions.map((dimension) => dimension.overall)).toEqual([5000, 5000, 3000]);
    expect(result.dimensionMismatches).toBe(0);
  });
});

describe('refusals leave the document unchanged', () => {
  it('unknown line, a disconnected line, a schema violation', () => {
    expectRefusal(loadedL101(), 'export_isometric', { lineId: 'NOPE' }, 'ISO_LINE_NOT_FOUND');
    expectRefusal(createEmptyDocument(), 'export_isometric', { lineId: 'L-101' }, 'ISO_LINE_NOT_FOUND');
    const far =
      'PIPE\n    COMPONENT-IDENTIFIER 16\n    END-POINT 20000.0 0.0 0.0 100 BW\n    END-POINT 21000.0 0.0 0.0 100 BW\n    ITEM-CODE PIPE-100-S40\nMATERIALS\n';
    const split = loadedL101(fixturePcf().replace('MATERIALS\n', far));
    const refused = expectRefusal(split, 'export_isometric', { lineId: 'L-101' }, 'ISO_DISCONNECTED', 'lineId');
    expect(refused.error?.ids).toEqual(['pcf:L-101:16']);
    const bad = execute(loadedL101(), 'export_isometric', { lineId: 'L-101', formats: [] });
    expect(bad.rejected).toBe(true);
    expect(bad.affected).toEqual([]);
  });

  it('a line with only zero-length parts has nothing to draw', () => {
    const text = fixturePcf();
    const record = [
      'WELD',
      '    COMPONENT-IDENTIFIER 1',
      '    END-POINT 0.0 0.0 0.0 100 BW',
      '    END-POINT 0.0 0.0 0.0 100 BW',
      '    SKEY WW',
    ];
    const weldOnly = `${text.slice(0, text.indexOf('FLANGE'))}${record.join('\n')}\nMATERIALS\n`;
    expect(execute(loadedL101(weldOnly), 'export_isometric', { lineId: 'L-101' }).rejected).toBe(true);
  });
});

describe('VC-ISO-17: pure, deterministic, replayable', () => {
  it('does not touch the document, gives the same bytes twice, and after replay_history', () => {
    const doc = apply(loadedL101(), 'number_welds', { lineId: 'L-101' });
    const before = JSON.stringify(doc);
    const first = execute(doc, 'export_isometric', { lineId: 'L-101', style: 'final', formats: ['svg', 'dxf'] });
    expect(first.document).toBe(doc);
    expect(first.affected).toEqual([]);
    expect(JSON.stringify(doc)).toBe(before);
    const second = execute(doc, 'export_isometric', { lineId: 'L-101', style: 'final', formats: ['svg', 'dxf'] });
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
    const replayed = execute(doc, 'replay_history', {}).document;
    const again = execute(replayed, 'export_isometric', { lineId: 'L-101', style: 'final', formats: ['svg', 'dxf'] });
    expect((again.data as Exported).files.map((file) => file.sha256)).toEqual((first.data as Exported).files.map((file) => file.sha256));
  });
});

describe('overflow, crossings and budget', () => {
  const staircase = (steps: number, pitch: number): number[][] => {
    const points = [[0, 0, 0]];
    for (let k = 0; k < steps; k++) {
      const last = points[points.length - 1] as number[];
      points.push(
        k % 3 === 0
          ? [(last[0] as number) + pitch, last[1] as number, last[2] as number]
          : k % 3 === 1
            ? [last[0] as number, (last[1] as number) + pitch, last[2] as number]
            : [last[0] as number, last[1] as number, (last[2] as number) + pitch],
      );
    }
    return points;
  };

  it('a large line is shrunk to its one sheet with ISO_SHEET_OVERFLOW; a 100 component line exports well inside the 500 ms budget (bound 3 x)', () => {
    const doc = apply(grade(), 'add_pipe_run', { points: staircase(50, 2500), dn: 100, line: 'BIG', service: 'water' });
    const started = performance.now();
    const result = exported(doc, { lineId: 'BIG', paper: 'A4', style: 'final' });
    const elapsed = performance.now() - started;
    expect(result.warnings.map((warning) => warning.code)).toContain('ISO_SHEET_OVERFLOW');
    expect(result.layout.overflow).toBe(true);
    expect(result.sheets[0]?.componentIds.length).toBeGreaterThanOrEqual(95);
    expect(result.dimensionMismatches).toBe(0);
    expect(elapsed).toBeLessThan(1500);
    expect(result.files[0]?.content).toContain('more row(s) in the data');
  });
});

describe('symbols of the other component families', () => {
  const NEWLINE = String.fromCharCode(10);
  const point = (x: number, bore: number, end = 'BW'): string => `    END-POINT ${x}.0 0.0 0.0 ${bore} ${end}`;
  const component = (type: string, from: number, to: number, boreFrom = 100, boreTo = 100, extra: string[] = []): string =>
    [type, point(from, boreFrom), point(to, boreTo), ...extra].join(NEWLINE);
  const text = [
    'ISOGEN-FILES ISOGEN.FLS',
    'UNITS-BORE MM',
    'UNITS-CO-ORDS MM',
    'PIPELINE-REFERENCE S-1',
    component('PIPE', 0, 1000, 100, 100, ['    ITEM-CODE P']),
    component('VALVE', 1000, 1300, 100, 100, ['    SKEY VTFL', '    ITEM-CODE V']),
    component('REDUCER-CONCENTRIC', 1300, 1500, 100, 80, ['    SKEY RCBW', '    ITEM-CODE R']),
    component('INSTRUMENT', 1500, 1700, 80, 80, ['    SKEY IRFL', '    ITEM-CODE I']),
    component('FLANGE-BLIND', 1700, 1776, 80, 80, ['    SKEY BLRF', '    ITEM-CODE B']),
    ['CAP', point(1776, 80), '    SKEY CPBW', '    ITEM-CODE C'].join(NEWLINE),
    '',
  ].join(NEWLINE);

  it('a valve, reducer, instrument, blind flange and cap each draw their symbol and the line dimensions close', () => {
    const doc = apply(createEmptyDocument(), 'import_pcf', { text });
    const result = exported(doc, { lineId: 'S-1' });
    expect(result.dimensionMismatches).toBe(0);
    expect(result.dimensions[0]?.values).toEqual([1000, 300, 200, 200, 76]);
    const svg = result.files[0]?.content ?? '';
    expect(svg.match(/<polygon/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('<circle');
  });
});
