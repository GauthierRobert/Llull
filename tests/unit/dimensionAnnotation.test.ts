import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { dimensionDrawing, dimensionText, formatDimensionValue } from '@core/geometry/dimensionAnnotation';
import { xy } from '../helpers/xy';

function draw(doc: CadDocument, command: string, params: object): { doc: CadDocument; entity: Entity } {
  const result = execute(doc, command, params);
  return { doc: result.document, entity: result.document.entities[result.affected[0]!]! };
}

function sketch(): { doc: CadDocument; ids: Record<string, Entity> } {
  let doc = createEmptyDocument();
  const ids: Record<string, Entity> = {};
  const add = (name: string, command: string, params: object): void => {
    const made = draw(doc, command, params);
    doc = made.doc;
    ids[name] = made.entity;
  };
  add('bottom', 'draw_polyline', { points: xy(0, 0, 100, 0) });
  add('top', 'draw_polyline', { points: xy(0, 60, 100, 60) });
  add('left', 'draw_polyline', { points: xy(0, 0, 0, 60) });
  add('right', 'draw_polyline', { points: xy(100, 0, 100, 60) });
  add('slanted', 'draw_polyline', { points: xy(0, 0, 30, 40) });
  add('circle', 'draw_arc', { center: [50, 30], radius: 12.5 });
  add('p0', 'draw_point', { position: [0, 0, 0] });
  add('p1', 'draw_point', { position: [10, 0, 0] });
  add('p2', 'draw_point', { position: [0, 10, 0] });
  return { doc, ids };
}

describe('dimensionDrawing', () => {
  const { ids } = sketch();
  const value = (kind: Parameters<typeof dimensionDrawing>[0], refs: Entity[], offset = 5): number | undefined =>
    dimensionDrawing(kind, refs, offset)?.value;

  it('linear measures X for a mostly horizontal pair and Y for a mostly vertical pair', () => {
    expect(value('linear', [ids.left!, ids.right!])).toBeCloseTo(100);
    expect(value('linear', [ids.bottom!, ids.top!])).toBeCloseTo(60);
  });
  it('aligned measures the true distance, parallel dimension line offset by `offset`', () => {
    const drawing = dimensionDrawing('aligned', [ids.p0!, ids.p1!], 4)!;
    expect(drawing.value).toBeCloseTo(10);
    expect(drawing.textAt[1]).toBeCloseTo(4);
    expect(drawing.segments.length).toBeGreaterThanOrEqual(3);
  });
  it('radial is the radius and diameter twice the radius, with arrowheads', () => {
    expect(value('radial', [ids.circle!])).toBeCloseTo(12.5);
    const diameter = dimensionDrawing('diameter', [ids.circle!], 1)!;
    expect(diameter.value).toBeCloseTo(25);
    expect(diameter.segments).toHaveLength(5);
  });
  it('angular from a vertex and two points, or from two lines meeting at an intersection', () => {
    expect(value('angular', [ids.p0!, ids.p1!, ids.p2!])).toBeCloseTo(90);
    expect(value('angular', [ids.bottom!, ids.left!])).toBeCloseTo(90);
    const slanted = value('angular', [ids.bottom!, ids.slanted!])!;
    expect(slanted).toBeCloseTo((Math.atan2(40, 30) * 180) / Math.PI);
  });
  it('angular between crossing lines uses their intersection, not an endpoint', () => {
    expect(value('angular', [ids.top!, ids.right!])).toBeCloseTo(90);
  });
  it('returns null for parallel lines, wrong kinds and missing references', () => {
    expect(dimensionDrawing('angular', [ids.bottom!, ids.top!], 5)).toBeNull();
    expect(dimensionDrawing('radial', [ids.bottom!], 5)).toBeNull();
    expect(dimensionDrawing('linear', [ids.bottom!, undefined], 5)).toBeNull();
    expect(dimensionDrawing('angular', [ids.p0!, ids.p1!], 5)).toBeNull();
  });
  it('a zero-length linear dimension has value 0 and nothing to draw', () => {
    const drawing = dimensionDrawing('linear', [ids.p0!, ids.p0!], 5)!;
    expect([drawing.value, drawing.segments]).toEqual([0, []]);
  });
});

describe('dimension text', () => {
  it('formats lengths at the precision, diameters with Ø and angles with one decimal and °', () => {
    expect(formatDimensionValue('linear', 12.3456, 2)).toBe('12.35');
    expect(formatDimensionValue('diameter', 25, 1)).toBe('Ø25.0');
    expect(formatDimensionValue('angular', 90, 5)).toBe('90.0°');
  });
  it('appends the tolerance to the value, and a label replaces both', () => {
    const base = { dimensionKind: 'linear' as const };
    expect(dimensionText({ ...base, tolerance: '±0.1' }, 10, 1)).toBe('10.0 ±0.1');
    expect(dimensionText({ ...base, precision: 0 }, 10.4, 3)).toBe('10');
    expect(dimensionText({ ...base, tolerance: '±0.1', label: 'REF' }, 10, 1)).toBe('REF');
  });
});

describe('dimension style look (arrowheads, extension lines, number format)', () => {
  const { ids } = sketch();
  const linear = (look: Parameters<typeof dimensionDrawing>[4]) => dimensionDrawing('linear', [ids['left'], ids['right']], 5, 0.3, look)!;

  it('draws open (default), closed, tick, dot and no arrowheads', () => {
    expect(linear({}).segments).toHaveLength(3 + 4);
    expect(linear({ arrowStyle: 'closed' }).segments).toHaveLength(3 + 6);
    expect(linear({ arrowStyle: 'tick' }).segments).toHaveLength(3 + 2);
    expect(linear({ arrowStyle: 'dot' }).segments).toHaveLength(3 + 16);
    expect(linear({ arrowStyle: 'none' }).segments).toHaveLength(3);
    const radial = dimensionDrawing('diameter', [ids['circle']], 5, 0.3, { arrowStyle: 'none' })!;
    expect(radial.segments).toHaveLength(1);
  });
  it('tick is a 45° slash of arrow length through the dimension-line end', () => {
    const [, , , slash] = linear({ arrowStyle: 'tick' }).segments;
    const [[ax, ay], [bx, by]] = slash!;
    expect(Math.hypot(bx - ax, by - ay)).toBeCloseTo(0.3, 9);
    expect(Math.abs(bx - ax)).toBeCloseTo(Math.abs(by - ay), 9);
  });
  it('extension lines start after the gap and run past the dimension line', () => {
    const [plain] = linear({}).segments;
    const [styled] = linear({ extensionGap: 1, extensionBeyond: 2 }).segments;
    const length = (segment: typeof plain): number => Math.hypot(segment![1][0] - segment![0][0], segment![1][1] - segment![0][1]);
    expect(length(styled)).toBeCloseTo(length(plain) - 1 + 2, 9);
    expect(linear({ extensionGap: 999 }).segments[0]![0]).toEqual(plain![1]);
  });
  it('formats separators, affixes and angular precision', () => {
    expect(formatDimensionValue('linear', 12.345, 2, { decimalSeparator: ',', prefix: '~', suffix: ' mm' })).toBe('~12,35 mm');
    expect(formatDimensionValue('diameter', 20, 0, { prefix: 'x' })).toBe('Øx20');
    expect(formatDimensionValue('angular', 45.123, 3, { angularPrecision: 2 })).toBe('45.12°');
    expect(formatDimensionValue('angular', 45.123, 3)).toBe('45.1°');
    const text = dimensionText({ dimensionKind: 'linear', tolerance: '±0.1' }, 3, 3, { precision: 1 });
    expect(text).toBe('3.0 ±0.1');
  });
});
