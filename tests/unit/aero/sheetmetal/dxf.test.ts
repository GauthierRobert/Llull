import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { bracket } from './helpers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface DxfEntity {
  type: string;
  layer: string;
  codes: Map<number, string[]>;
}

interface DxfData {
  dxf: string;
  filename: string;
  unit: string;
  unitDefaulted: boolean;
  extents: [number, number];
  entityCount: number;
  layers: string[];
  reviewRequired: boolean;
  unverified: boolean;
}

/** Strict group-code reader: pairs of lines, sections in order, returns header values and the ENTITIES list. */
function parseDxf(text: string): { header: Map<string, string>; entities: DxfEntity[]; tail: string[] } {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  expect(lines.length % 2).toBe(0);
  const pairs = Array.from({ length: lines.length / 2 }, (_, i): [number, string] => [Number(lines[2 * i]), lines[2 * i + 1] as string]);
  const header = new Map<string, string>();
  const entities: DxfEntity[] = [];
  let section = '';
  let variable = '';
  let current: DxfEntity | null = null;
  const tail: string[] = [];
  for (const [code, value] of pairs) {
    expect(Number.isFinite(code)).toBe(true);
    if (code === 0 && value === 'SECTION') continue;
    if (code === 2 && section === '' && value !== '') {
      section = value;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      section = '';
      current = null;
      continue;
    }
    if (code === 0 && value === 'EOF') {
      tail.push('EOF');
      continue;
    }
    if (section === 'HEADER') {
      if (code === 9) variable = value;
      else if (!header.has(variable)) header.set(variable, value);
    } else if (section === 'ENTITIES') {
      if (code === 0) {
        current = { type: value, layer: '', codes: new Map() };
        entities.push(current);
      } else if (current !== null) {
        if (code === 8) current.layer = value;
        current.codes.set(code, [...(current.codes.get(code) ?? []), value]);
      }
    }
  }
  return { header, entities, tail };
}

const number = (entity: DxfEntity, code: number): number => Number(entity.codes.get(code)?.[0]);

describe('export_flat_pattern_dxf (VC-FTR-09, 41)', () => {
  const { doc, part } = bracket();
  const result = data<DxfData>(doc, 'export_flat_pattern_dxf', { id: part });
  const parsed = parseDxf(result.dxf);

  it('is a well-formed R12 file of LINE / CIRCLE / TEXT only', () => {
    expect(parsed.header.get('$ACADVER')).toBe('AC1009');
    expect(parsed.tail).toEqual(['EOF']);
    expect(new Set(parsed.entities.map((entity) => entity.type))).toEqual(new Set(['LINE', 'TEXT']));
    expect(result.entityCount).toBe(parsed.entities.length);
    expect(result.filename).toBe(`${part}_flat.dxf`);
  });

  it('puts the outline, one bend line and the notes on their layers', () => {
    const onLayer = (layer: string): DxfEntity[] => parsed.entities.filter((entity) => entity.layer === layer);
    expect(onLayer('OUTLINE')).toHaveLength(4);
    expect(onLayer('BEND_UP')).toHaveLength(1);
    expect(onLayer('BEND_DOWN')).toHaveLength(0);
    expect(onLayer('CUTOUT')).toHaveLength(0);
    expect(result.layers).toEqual(['OUTLINE', 'BEND_UP', 'NOTES']);
    const notes = onLayer('NOTES').map((entity) => entity.codes.get(1)?.[0] ?? '');
    expect(notes.some((note) => note.includes('not approved'))).toBe(true);
    expect(notes.some((note) => note.startsWith('BEND b1 UP 90 deg R4.8'))).toBe(true);
  });

  it('has the flat pattern extents 65.8457 x 50 mm and $INSUNITS 4', () => {
    const geometry = parsed.entities.filter((entity) => entity.type === 'LINE');
    const xs = geometry.flatMap((entity) => [number(entity, 10), number(entity, 11)]);
    const ys = geometry.flatMap((entity) => [number(entity, 20), number(entity, 21)]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(65.8457, 4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(50, 6);
    expect(result.extents[0]).toBeCloseTo(65.8457, 4);
    expect(parsed.header.get('$INSUNITS')).toBe('4');
    const bend = geometry.find((entity) => entity.layer === 'BEND_UP');
    expect(number(bend as DxfEntity, 10)).toBeCloseTo(33.6 + 8.645662983 / 2, 5);
  });

  it('declares header extents that cover every entity, the notes text (below and wider than the pattern) included', () => {
    const lines = result.dxf.split('\n');
    const extentY = (variable: string): number => Number(lines[lines.indexOf(variable) + 4]);
    const textYs = parsed.entities.filter((entity) => entity.type === 'TEXT').map((entity) => number(entity, 20));
    expect(textYs.length).toBeGreaterThan(0);
    expect(extentY('$EXTMIN')).toBeLessThanOrEqual(Math.min(...textYs));
    expect(extentY('$EXTMAX')).toBeCloseTo(50, 6);
    const extentX = (variable: string): number => Number(lines[lines.indexOf(variable) + 2]);
    const longest = Math.max(
      ...parsed.entities
        .filter((entity) => entity.type === 'TEXT')
        .map((entity) => (entity.codes.get(1)?.[0] ?? '').length * number(entity, 40)),
    );
    expect(extentX('$EXTMAX')).toBeGreaterThan(longest * 0.5);
  });

  it('carries the review flags in the result (VC-FTR-41)', () => {
    const answer = ok(doc, 'export_flat_pattern_dxf', { id: part });
    expect(answer.summary).toContain('not approved');
    expect(answer.document).toBe(doc);
    expect(result.reviewRequired).toBe(true);
    expect(result.unit).toBe('mm');
    expect(result.unitDefaulted).toBe(true);
  });

  it('round-trips through the repository DXF reader', () => {
    const imported = ok(createEmptyDocument(), 'import_dxf', { text: result.dxf });
    expect(imported.affected.length).toBeGreaterThanOrEqual(5);
  });
});

describe('export_flat_pattern_dxf options', () => {
  it('converts to inches and sets $INSUNITS 1', () => {
    const { doc, part } = bracket();
    const inches = data<DxfData>(doc, 'export_flat_pattern_dxf', { id: part, units: 'in' });
    const parsed = parseDxf(inches.dxf);
    expect(parsed.header.get('$INSUNITS')).toBe('1');
    expect(inches.extents[0]).toBeCloseTo(65.845663 / 25.4, 5);
    expect(inches.unit).toBe('in');
    expect(inches.unitDefaulted).toBe(false);
  });

  it('can leave out bend lines and bend notes, and draws circle cutouts as CIRCLE', () => {
    const { doc, part } = bracket();
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = apply(circle.document, 'add_sheet_cutout', { id: part, face: { near: [10, 25, 0] }, profileId: circle.affected[0] });
    const plain = parseDxf(data<DxfData>(cut, 'export_flat_pattern_dxf', { id: part, bendLines: false, bendNotes: false }).dxf);
    expect(plain.entities.filter((entity) => entity.layer === 'BEND_UP')).toHaveLength(0);
    expect(plain.entities.filter((entity) => entity.type === 'TEXT' && (entity.codes.get(1)?.[0] ?? '').startsWith('BEND'))).toHaveLength(
      0,
    );
    const circles = plain.entities.filter((entity) => entity.type === 'CIRCLE');
    expect(circles).toHaveLength(1);
    expect(number(circles[0] as DxfEntity, 40)).toBeCloseTo(4, 9);
    expect(circles[0]?.layer).toBe('CUTOUT');
  });

  it('refuses an unknown part', () => {
    expectRefusal(createEmptyDocument(), 'export_flat_pattern_dxf', { id: 'sm-1.1' }, 'FTR_PART_NOT_FOUND', 'id');
    expect(execute(createEmptyDocument(), 'export_flat_pattern_dxf', { id: 'x', units: 'furlong' }).error?.code).toBe('CMD_INVALID_PARAMS');
  });
});
