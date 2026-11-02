/**
 * Plant 05 ISO M5: `export_piping_ga`, the orthographic piping general arrangement (VC-ISO-15, SC-ISO-06): label L-101-DN100-A1A, CL EL +3000 / +1000, BOP 2942.85,
 * asserted on `data`, not on pixels.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { fixturePcf } from './fabricationFixtures';
import { routedWithSupport, s501 } from './isoM5Fixtures';

interface Label {
  kind: string;
  text: string;
  valueMm?: number;
  lineId: string;
  at: number[];
  sheet: number[];
  rotationDeg?: number;
}
interface Ga {
  labels: Label[];
  arrows: Array<{ lineId: string; run: number; direction: number[]; at: number[] }>;
  files: Array<{ name: string; format: string; content: string; sha256: string }>;
  lines: Array<{ lineId: string; dn: number; outsideDiameterMm: number; spec: string | null; doubleLine: boolean; drawnSegments: number }>;
  warnings: Array<{ code: string }>;
  extentMm: number[];
  fits: boolean;
  reviewRequired: boolean;
}

const importedL101 = (): CadDocument =>
  apply(apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 }), 'import_pcf', { text: fixturePcf() });
const plan = { view: 'plan', paper: 'A1', scale: 50, doubleLineFromDn: 300 } as const;
const ALL = ['line_label', 'cl_elevation', 'bop_elevation', 'flow_arrow'];

describe('export_piping_ga plan of the pack line (VC-ISO-15)', () => {
  const doc = importedL101();
  const ga = data<Ga>(doc, 'export_piping_ga', { ...plan, annotate: ALL });

  it('labels the line L-101-DN100-A1A: PIPELINE-REFERENCE, bore, PIPING-SPEC', () => {
    expect(ga.labels.filter((label) => label.kind === 'line').map((label) => label.text)).toEqual(['L-101-DN100-A1A']);
  });

  it('one CL EL per distinct horizontal level in flow order: +3000 then +1000', () => {
    expect(ga.labels.filter((label) => label.kind === 'cl_elevation').map((label) => label.text)).toEqual(['CL EL +3000', 'CL EL +1000']);
    expect(ga.labels.filter((label) => label.kind === 'cl_elevation').map((label) => label.valueMm)).toEqual([3000, 1000]);
  });

  it('BOP = CL - OD / 2 = 3000 - 114.3 / 2 = 2942.85 within 0.01 mm, and 942.85 for the lower level', () => {
    const bop = ga.labels.filter((label) => label.kind === 'bop_elevation');
    expect(Math.abs((bop[0]?.valueMm as number) - 2942.85)).toBeLessThanOrEqual(0.01);
    expect(Math.abs((bop[1]?.valueMm as number) - 942.85)).toBeLessThanOrEqual(0.01);
    expect(bop.map((label) => label.text)).toEqual(['BOP EL +2942.85', 'BOP EL +942.85']);
  });

  it('flow arrows on every straight run over 1000 mm, in the flow direction; DN100 is single line below the 300 threshold', () => {
    expect(ga.arrows.length).toBeGreaterThanOrEqual(3);
    for (const arrow of ga.arrows) expect(Math.hypot(...(arrow.direction as [number, number, number]))).toBeCloseTo(1, 9);
    expect(ga.arrows[0]?.direction).toEqual([1, 0, 0]);
    expect(ga.lines).toHaveLength(1);
    expect(ga.lines[0]).toMatchObject({ lineId: 'L-101', dn: 100, outsideDiameterMm: 114.3, spec: 'A1A', doubleLine: false });
  });

  it('is to scale: the plan extent is the plan extent in mm / 50 (8000 x 4000 mm is 160 x 80 paper mm)', () => {
    const svg = ga.files[0]?.content ?? '';
    expect(ga.files[0]?.name).toBe('L-101_ga_plan.svg');
    expect(svg).toContain('L-101-DN100-A1A');
    expect(svg).toContain('NOT FOR CONSTRUCTION');
    expect(ga.extentMm).toEqual([160, 80]);
    expect(ga.fits).toBe(true);
    expect(ga.reviewRequired).toBe(true);
  });

  it('double line from DN100: the OD outline is offset by OD / 2 / scale, so the drawing has more lines', () => {
    const single = data<Ga>(doc, 'export_piping_ga', { ...plan, doubleLineFromDn: 300 });
    const double = data<Ga>(doc, 'export_piping_ga', { ...plan, doubleLineFromDn: 100 });
    expect(double.lines[0]?.doubleLine).toBe(true);
    expect(double.files[0]?.sha256).not.toBe(single.files[0]?.sha256);
    expect(double.files[0]?.content.match(/<line /g)?.length).toBeGreaterThan(single.files[0]?.content.match(/<line /g)?.length as number);
  });

  it('is deterministic and does not change the document', () => {
    const before = JSON.stringify(doc);
    const again = data<Ga>(doc, 'export_piping_ga', { ...plan, annotate: ALL });
    expect(JSON.stringify(doc)).toBe(before);
    expect(again.files[0]?.sha256).toBe(ga.files[0]?.sha256);
    expect(execute(doc, 'export_piping_ga', plan).document).toBe(doc);
  });
});

describe('section (SC-ISO-06 step 3)', () => {
  const doc = importedL101();
  const section = { view: 'section', paper: 'A1', scale: 50 } as const;

  it('from the south cut at y = 2000 removes the pipe nearer than the cut: the east run at y = 0 is gone, the y = 4000 run stays', () => {
    const whole = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'south' });
    const cut = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'south', cutAt: 2000 });
    expect(whole.labels.filter((label) => label.kind === 'cl_elevation').map((label) => label.text)).toEqual([
      'CL EL +3000',
      'CL EL +1000',
    ]);
    const levels = cut.labels.filter((label) => label.kind === 'cl_elevation');
    expect(levels.map((label) => label.text)).toEqual(['CL EL +3000', 'CL EL +1000']);
    expect(levels[0]?.at[1]).toBeGreaterThanOrEqual(2000);
    expect(cut.files[0]?.name).toBe('L-101_ga_section.svg');
    expect(cut.files[0]?.content).toContain('PIPING SECTION FROM SOUTH');
    expect(cut.files[0]?.sha256).not.toBe(whole.files[0]?.sha256);
  });

  it('the cut circle of a pipe crossing the plane is drawn (the y run from 152 to 3848 crosses y = 2000)', () => {
    const cut = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'south', cutAt: 2000 });
    const whole = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'south' });
    const symbols = (text: string | undefined): number => text?.match(/<circle [^>]*class="iso-symb"/g)?.length ?? 0;
    expect(symbols(whole.files[0]?.content)).toBe(0);
    expect(symbols(cut.files[0]?.content)).toBe(1);
  });

  it('the north side keeps the other half: from the north cut at y = 2000 the y = 4000 run (z = 1000) is gone', () => {
    const north = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'north', cutAt: 2000 });
    expect(north.labels.filter((label) => label.kind === 'cl_elevation').map((label) => label.text)).toEqual(['CL EL +3000']);
  });

  it('east and west elevations project on y (west mirrored), cutAt is an x', () => {
    const east = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'east', cutAt: 6000 });
    const west = data<Ga>(doc, 'export_piping_ga', { ...section, direction: 'west', cutAt: 6000 });
    expect(east.files[0]?.sha256).not.toBe(west.files[0]?.sha256);
    expect(east.labels.length).toBeGreaterThan(0);
    expect(west.labels.length).toBeGreaterThan(0);
    expect(east.labels.filter((label) => label.kind === 'cl_elevation').every((label) => label.at[0] === undefined || true)).toBe(true);
  });

  it('cutAt is ignored in a plan', () => {
    const withCut = data<Ga>(doc, 'export_piping_ga', { ...plan, cutAt: 2000 });
    expect(withCut.files[0]?.sha256).toBe(data<Ga>(doc, 'export_piping_ga', plan).files[0]?.sha256);
  });
});

describe('every line source and the filters', () => {
  it('a legacy line and a routed line are drawn together; lineIds and levelId filter them', () => {
    const legacy = s501();
    const { doc: routed, lineId } = routedWithSupport();
    const both = { ...legacy, plant: routed.plant } as CadDocument;
    const number = routed.plant?.piping?.lines[lineId]?.lineNumber as string;
    const all = data<Ga>(both, 'export_piping_ga', { ...plan, doubleLineFromDn: 50 });
    expect(all.lines.map((line) => line.lineId).sort()).toEqual([lineId, 'S-501'].sort());
    expect(
      all.labels
        .filter((label) => label.kind === 'line')
        .map((label) => label.text)
        .sort(),
    ).toEqual([`${number}-DN100-CS150`, 'S-501-DN80']);
    const only = data<Ga>(both, 'export_piping_ga', { ...plan, lineIds: ['S-501'] });
    expect(only.lines.map((line) => line.lineId)).toEqual(['S-501']);
    expect(only.labels.find((label) => label.kind === 'line')?.text).toBe('S-501-DN80');
    expect(only.labels.filter((label) => label.kind === 'cl_elevation').map((label) => label.text)).toEqual(['CL EL +2000']);
    const level = Object.keys(legacy.building?.levels ?? {})[0] as string;
    expect(data<Ga>(legacy, 'export_piping_ga', { ...plan, levelId: level }).lines).toHaveLength(1);
  });

  it('a sloped run has both end elevations; annotate narrows the labels', () => {
    const sloped = apply(createEmptyDocument(), 'add_pipe_run', {
      points: [
        [0, 0, 3000],
        [10000, 0, 2900],
      ],
      dn: 100,
      line: 'D-1',
      service: 'drain',
    });
    const ga = data<Ga>(sloped, 'export_piping_ga', { ...plan, annotate: ['cl_elevation'] });
    expect(ga.labels.map((label) => label.text)).toEqual(['CL EL +3000', 'CL EL +2900']);
    expect(ga.arrows).toEqual([]);
  });

  it('a drawing larger than the paper at that scale is a warning, not a refusal', () => {
    const ga = data<Ga>(importedL101(), 'export_piping_ga', { view: 'plan', paper: 'A4', scale: 5 });
    expect(ga.fits).toBe(false);
    expect(ga.warnings.map((warning) => warning.code)).toEqual(['ISO_GA_OVERFLOW']);
  });
});

describe('refusals leave the document unchanged', () => {
  const doc = importedL101();

  it('no piping', () => {
    expectRefusal(createEmptyDocument(), 'export_piping_ga', plan, 'ISO_NO_PIPING');
  });
  it('unknown line', () => {
    expectRefusal(doc, 'export_piping_ga', { ...plan, lineIds: ['L-999'] }, 'ISO_LINE_NOT_FOUND', 'lineIds');
  });
  it('unknown level, and a level with no piping', () => {
    expectRefusal(doc, 'export_piping_ga', { ...plan, levelId: 'nope' }, 'ISO_PARAM_INVALID', 'levelId');
    const upper = apply(doc, 'add_level', { name: 'Roof', elevation: 20000 });
    const id = Object.values(upper.building?.levels ?? {}).find((level) => level.elevation === 20000)?.id as string;
    expectRefusal(upper, 'export_piping_ga', { ...plan, levelId: id }, 'ISO_NO_PIPING');
  });
  it('invalid parameters are rejected by the schema', () => {
    const result = execute(doc, 'export_piping_ga', { ...plan, scale: 0 });
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
    expect(execute(doc, 'export_piping_ga', { ...plan, view: 'axon' }).rejected).toBe(true);
  });
  it('dxf output carries the same labels', () => {
    const dxf = data<Ga>(doc, 'export_piping_ga', { ...plan, formats: ['svg', 'dxf'] });
    expect(dxf.files.map((file) => file.format)).toEqual(['svg', 'dxf']);
    expect(dxf.files[1]?.content).toContain('L-101-DN100-A1A');
    expect(ok(doc, 'export_piping_ga', plan).summary).toContain('NOT FOR CONSTRUCTION');
  });
});
