import { describe, expect, it } from 'vitest';
import type { DrawingPrimitive } from '@core/model/drawing';
import { buildDrawingBuffers } from '../../src/ui/viewport/2d/drawingGeometry';
import { xy } from '../helpers/xy';

const SCALE = { patternUnit: 0.5, hatchSpacing: 1 };
const styled = (primitive: DrawingPrimitive): { primitive: DrawingPrimitive; color: string } => ({ primitive, color: '#ff0000' });
const segmentCount = (positions: ReadonlyArray<number>): number => positions.length / 6;
const square: DrawingPrimitive = { type: 'polygon', layer: 'L', style: 'cut', points: xy(0, 0, 4, 0, 4, 4, 0, 4), fill: 'hatch' };

describe('buildDrawingBuffers — ISO 128 line weights', () => {
  it('routes visible / cut to thick, hidden to dashed, thin to thin', () => {
    const line = (style: DrawingPrimitive['style']): DrawingPrimitive => ({ type: 'line', layer: 'L', style, a: [0, 0], b: [1, 0] });
    const buffers = buildDrawingBuffers(
      [styled(line('visible')), styled(line('cut')), styled(line('hidden')), styled(line('thin'))],
      SCALE,
      [0, 0],
    );
    expect(segmentCount(buffers.thick.positions)).toBe(2);
    expect(segmentCount(buffers.dashed.positions)).toBe(1);
    expect(segmentCount(buffers.thin.positions)).toBe(1);
    expect(buffers.thick.colors.slice(0, 3)).toEqual([1, 0, 0]);
  });
  it('hatches a hatch-filled cut at 45° (thin) instead of a solid poché, relative to the anchor', () => {
    const buffers = buildDrawingBuffers([styled(square)], SCALE, [10, 10]);
    expect(segmentCount(buffers.thick.positions)).toBe(4);
    expect(segmentCount(buffers.thin.positions)).toBeGreaterThan(3);
    expect(buffers.fills).toHaveLength(0);
    expect(buffers.thick.positions[0]).toBe(-10);
    const [x0, y0, , x1, y1] = buffers.thin.positions as number[];
    expect(Math.abs((y1 as number) - (y0 as number))).toBeCloseTo(Math.abs((x1 as number) - (x0 as number)));
  });
  it('fills only an explicit fill: solid keeps its holes, hatch draws lines, none stays open', () => {
    const buffers = buildDrawingBuffers(
      [
        styled({ ...square, fill: 'solid', holes: [xy(1, 1, 2, 1, 2, 2)] }),
        styled({ type: 'circle', layer: 'L', style: 'cut', center: [0, 0], radius: 1 }),
        styled({ type: 'circle', layer: 'L', style: 'cut', center: [9, 9], radius: 4, fill: 'hatch' }),
      ],
      SCALE,
      [0, 0],
    );
    expect(buffers.fills).toHaveLength(1);
    expect(buffers.fills[0]?.holes).toHaveLength(1);
    expect(segmentCount(buffers.thin.positions)).toBeGreaterThan(3);
  });
  it('breaks a centre line into long dashes and dots (chain line)', () => {
    const buffers = buildDrawingBuffers([styled({ type: 'line', layer: 'L', style: 'center', a: [0, 0], b: [20, 0] })], SCALE, [0, 0]);
    const pieces = segmentCount(buffers.thin.positions);
    expect(pieces).toBeGreaterThan(4);
    const lengths = Array.from({ length: pieces }, (_, i) =>
      Math.abs((buffers.thin.positions[i * 6 + 3] as number) - (buffers.thin.positions[i * 6] as number)),
    );
    // ISO 128 type 04: long dash 6 units, dot 1 unit.
    expect(Math.max(...lengths)).toBeCloseTo(SCALE.patternUnit * 6);
    expect(Math.min(...lengths)).toBeCloseTo(SCALE.patternUnit);
  });
  it('collects text and dimension labels; arcs and polylines are sampled', () => {
    const buffers = buildDrawingBuffers(
      [
        styled({ type: 'text', layer: 'L', style: 'annotation', at: [1, 1], height: 2, content: 'A' }),
        styled({ type: 'dimension', layer: 'L', style: 'thin', a: [0, 0], b: [-5, 0], offset: 1, label: '5000' }),
        styled({ type: 'arc', layer: 'L', style: 'thin', center: [0, 0], radius: 1, startAngle: 0, endAngle: Math.PI }),
        styled({ type: 'polyline', layer: 'L', style: 'center', points: xy(0, 0, 5, 0, 5, 5) }),
      ],
      SCALE,
      [0, 0],
    );
    expect(buffers.labels.map((label) => [label.content, label.dimension])).toEqual([
      ['A', false],
      ['5000', true],
    ]);
    expect(segmentCount(buffers.thin.positions)).toBeGreaterThan(5 + 32);
  });
});
