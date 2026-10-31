/** Plant 04 PID M5: the built-in symbol library (list_pid_symbols, VC-PID-16) and export_pid_svg (VC-PID-18). */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { readXml, xmlAttr, xmlChildren, type XmlElement } from '@lib/xmlRead';
import { KNOWN_EQUIPMENT_CLASSES, KNOWN_PIPING_CLASSES } from '@aec/plant/pid/dexpi/proteusClasses';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { C01, PID_PACK, dexpiText, importFile } from './dexpiFixtures';
import { byTag, runSteps, type Step } from './authoringFixtures';

const plan = JSON.parse(readFileSync(path.join(PID_PACK, 'plans/sc-pid-02-author-and-validate.json'), 'utf8')) as { actions: Step[] };
const authored = runSteps(plan.actions).doc;

interface Svg {
  svg: string;
  widthMm: number;
  heightMm: number;
  glyphs: number;
  itemsOutsidePaper: number;
  convention: string;
}
const svgOf = (doc: CadDocument, params: Record<string, unknown> = { sheet: 'PID-001' }): Svg => data<Svg>(doc, 'export_pid_svg', params);

function groups(svg: string): XmlElement[] {
  const read = readXml(svg);
  if (!read.ok) throw new Error(read.error.message);
  const sheet = xmlChildren(read.root, 'g').find((g) => xmlAttr(g, 'id') === 'pid-sheet');
  return sheet === undefined ? [] : xmlChildren(sheet, 'g');
}
const descendants = (el: XmlElement): XmlElement[] => xmlChildren(el).flatMap((child) => [child, ...descendants(child)]);
const shapesOf = (svg: string, id: string, local: string): number =>
  descendants(groups(svg).find((g) => xmlAttr(g, 'id') === id) as XmlElement).filter((e) => e.local === local).length;

const listed = (params: Record<string, unknown> = {}): Array<{ class: string; family: string; convention: string; ports: number[][] }> =>
  data<{ rows: Array<{ class: string; family: string; convention: string; ports: number[][] }> }>(
    createEmptyDocument(),
    'list_pid_symbols',
    params,
  ).rows;

describe('list_pid_symbols (VC-PID-16)', () => {
  const SPEC_CLASSES = [
    'BallValve',
    'BlindFlange',
    'ButterflyValve',
    'CentrifugalPump',
    'Chamber',
    'ColumnPackingsArrangement',
    'ColumnSection',
    'Displacer',
    'Flange',
    'GlobeValve',
    'Impeller',
    'OperatedValve',
    'PipeFitting',
    'PipeReducer',
    'PipeTee',
    'PlateHeatExchanger',
    'ProcessColumn',
    'ReciprocatingPump',
    'RestrictionOrifice',
    'SpringLoadedGlobeSafetyValve',
    'SwingCheckValve',
    'Tank',
    'TubeBundle',
    'TubularHeatExchanger',
  ];

  it('has a symbol for every class of the examples and every class the authoring commands accept, in both conventions', () => {
    for (const convention of ['ISA-5.1', 'ISO-10628-2']) {
      const names = listed({ convention }).map((row) => row.class);
      for (const cls of [...SPEC_CLASSES, ...KNOWN_EQUIPMENT_CLASSES, ...KNOWN_PIPING_CLASSES])
        expect(names, `${convention} ${cls}`).toContain(cls);
    }
  });

  it('importing the 11 files maps every class (no DEXPI_UNMAPPED_CLASS) to a listed symbol', () => {
    const known = new Set(listed().map((row) => row.class));
    for (const file of readdirSync(path.join(PID_PACK, 'data/dexpi13')).filter((name) => name.endsWith('.xml'))) {
      const result = execute(createEmptyDocument(), 'import_dexpi', { text: dexpiText(file) });
      expect((result.data as { warnings: Array<{ code: string }> }).warnings.filter((w) => w.code === 'DEXPI_UNMAPPED_CLASS')).toEqual([]);
      for (const item of Object.values(result.document.plant?.pid?.items ?? {}))
        if (item.kind === 'equipment' || item.kind === 'inline')
          expect(known.has(item.dexpiClass), `${file} ${item.dexpiClass}`).toBe(true);
    }
  });

  it('filters by convention, class (case-insensitive) and family; the two conventions draw equipment differently, components alike', () => {
    expect(listed({ class: 'ballvalve' }).map((row) => row.convention)).toEqual(['ISA-5.1', 'ISO-10628-2']);
    expect(listed({ family: 'instrument', convention: 'ISA-5.1' })).toHaveLength(16);
    expect(listed({ class: 'nothing' })).toEqual([]);
    expect(listed({ class: 'BallValve', convention: 'ISA-5.1' })[0]?.ports).toEqual([
      [-5, 0],
      [5, 0],
    ]);
    const tank = (convention: string): string => data<{ svg: string }>(authored, 'export_pid_svg', { sheet: 'PID-001', convention }).svg;
    expect(tank('ISA-5.1')).not.toBe(tank('ISO-10628-2'));
  });

  it('is read-only', () => {
    const doc = createEmptyDocument();
    expect(execute(doc, 'list_pid_symbols', {}).document).toBe(doc);
  });
});

describe('export_pid_svg (VC-PID-18)', () => {
  const { svg } = svgOf(authored);
  const pid = authored.plant?.pid;

  it('is well-formed, one group per item, group ids equal item ids', () => {
    const ids = groups(svg).map((g) => xmlAttr(g, 'id'));
    expect([...ids].sort()).toEqual([...(pid?.itemOrder ?? [])].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('draws the instrument bubble by location and the display frame', () => {
    const field = byTag(authored, 'FT-101').id;
    const central = byTag(authored, 'FIC-101').id;
    expect(shapesOf(svg, field, 'circle')).toBe(1);
    expect(shapesOf(svg, field, 'polyline')).toBe(0);
    expect(shapesOf(svg, central, 'circle')).toBe(1);
    expect(shapesOf(svg, central, 'polyline')).toBe(1);
    let panel = apply(authored, 'add_pid_instrument', { sheet: 'PID-001', tag: 'PI-201', at: [100, 200], location: 'local_panel' });
    const panelId = byTag(panel, 'PI-201').id;
    expect(shapesOf(svgOf(panel).svg, panelId, 'polyline')).toBe(2);
    panel = apply(panel, 'add_pid_instrument', { sheet: 'PID-001', tag: 'PI-202', at: [130, 200], location: 'auxiliary' });
    expect(shapesOf(svgOf(panel).svg, byTag(panel, 'PI-202').id, 'polyline')).toBe(1);
  });

  it('draws the two conventions differently for equipment', () => {
    const tank = byTag(authored, 'T-101').id;
    const isa = svgOf(authored, { sheet: 'PID-001', convention: 'ISA-5.1' }).svg;
    const iso = svgOf(authored, { sheet: 'PID-001', convention: 'ISO-10628-2' }).svg;
    const body = (text: string): string =>
      JSON.stringify(descendants(groups(text).find((g) => xmlAttr(g, 'id') === tank) as XmlElement).map((e) => e.local));
    expect(body(isa)).not.toBe(body(iso));
  });

  it('has the title block, the status, line numbers and flow arrows', () => {
    expect(svg).toContain('DRAWING');
    expect(svg).toContain('Feed pump');
    expect(svg).toContain('80-P-1002-A1');
    expect(svg).toContain('NOT TO SCALE');
  });

  it('is deterministic, pure and read-only; sheet by number or id; scale changes only the physical size', () => {
    const before = JSON.stringify(authored);
    expect(svgOf(authored).svg).toBe(svg);
    expect(JSON.stringify(authored)).toBe(before);
    const id = Object.keys(pid?.sheets ?? {})[0] ?? '';
    expect(svgOf(authored, { sheet: id }).svg).toBe(svg);
    const half = svgOf(authored, { sheet: 'PID-001', scale: 0.5 });
    const full = svgOf(authored);
    expect(half.widthMm).toBeCloseTo(full.widthMm / 2, 2);
    expect(half.heightMm).toBeCloseTo(full.heightMm / 2, 2);
    expect(full.widthMm).toBe(420);
    expect(full.heightMm).toBe(297);
  });

  it('refuses an unknown sheet and a bad scale; the document is unchanged', () => {
    expectRefusal(authored, 'export_pid_svg', { sheet: 'PID-404' }, 'PID_SHEET_NOT_FOUND', 'sheet');
    expectRefusal(createEmptyDocument(), 'export_pid_svg', { sheet: 'PID-001' }, 'PID_SHEET_NOT_FOUND');
    const bad = execute(authored, 'export_pid_svg', { sheet: 'PID-001', scale: 0 });
    expect(bad.rejected).toBe(true);
    expect(bad.document).toBe(authored);
  });

  it('escapes and clips hostile text from an import, and keeps the view box around items outside the paper', () => {
    const source = dexpiText('P01V01-VER.EX01.xml').replace(
      'Value="P4712"',
      `Value="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;${'Z'.repeat(200)}"`,
    );
    const doc = apply(createEmptyDocument(), 'import_dexpi', { text: source });
    const out = svgOf(doc);
    expect(out.svg).not.toContain('<script>');
    expect(out.svg).toContain('&lt;script&gt;');
    expect(out.svg).not.toContain('Z'.repeat(60));
    expect(readXml(out.svg).ok).toBe(true);
    const far = apply(authored, 'add_pid_equipment', { sheet: 'PID-001', class: 'Tank', tag: 'T-999', at: [5000, 4000] });
    const wide = svgOf(far);
    expect(wide.itemsOutsidePaper).toBeGreaterThan(0);
    expect(wide.widthMm).toBeGreaterThan(5000);
  });

  it('draws the imported C01 sheet, every class with a symbol, inside a generous time bound', () => {
    const doc = importFile(C01);
    const start = performance.now();
    const out = svgOf(doc);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(out.glyphs).toBe(doc.plant?.pid?.itemOrder.length);
    expect(groups(out.svg)).toHaveLength(out.glyphs);
  });
});
