/** render_view label placement: crossing dimensions and the angular label no longer overlap each other or the world triad. */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { boxesOverlap, placeLabels, textBox, triadBox } from '@core/commands/render/labelPlacement';
import { dimensionDrawing } from '@core/geometry/dimensionAnnotation';
import { xy } from '../helpers/xy';

function crossingDimensions(): CadDocument {
  let doc = createEmptyDocument();
  const run = (command: string, params: object): string => {
    const result = execute(doc, command, params);
    doc = result.document;
    return result.affected[0] ?? '';
  };
  const left = run('draw_polyline', { points: xy(0, 0, 0, 60) });
  const right = run('draw_polyline', { points: xy(100, 0, 100, 60) });
  const bottom = run('draw_polyline', { points: xy(0, 0, 100, 0) });
  const top = run('draw_polyline', { points: xy(0, 60, 100, 60) });
  run('add_dimension', { dimensionKind: 'linear', entityIds: [left, right], offset: 10 });
  run('add_dimension', { dimensionKind: 'linear', entityIds: [bottom, top], offset: 10 });
  run('add_dimension', { dimensionKind: 'angular', entityIds: [bottom, left] });
  return doc;
}

const svgOf = (doc: CadDocument): string =>
  (execute(doc, 'render_view', { view: 'top', width: 800, height: 600 }).data as { svg: string }).svg;

interface DrawnLabel {
  readonly id: string;
  readonly box: ReturnType<typeof textBox>;
}

function dimensionLabels(svg: string): DrawnLabel[] {
  const pattern =
    /<text data-entity-id="([^"]+)" data-kind="dimension" x="([-\d.]+)" y="([-\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/text>/g;
  return [...svg.matchAll(pattern)].map((match) => {
    const content = [...(match[5] ?? '').matchAll(/>([^<]*)<\/tspan>/g)].map((line) => line[1] ?? '');
    return { id: match[1] ?? '', box: textBox(Number(match[2]), Number(match[3]), content, Number(match[4]), -0.3, 'middle', 0) };
  });
}

describe('label placement', () => {
  it('keeps the labels of crossing dimensions and the angular label apart, deterministically', () => {
    const doc = crossingDimensions();
    const svg = svgOf(doc);
    const labels = dimensionLabels(svg);
    expect(labels).toHaveLength(3);
    for (const [i, a] of labels.entries())
      for (const b of labels.slice(i + 1)) expect(boxesOverlap(a.box, b.box), `${a.id} vs ${b.id}`).toBe(false);
    expect(svgOf(doc)).toBe(svg);
  });

  it('keeps dimension labels off the world triad at the origin', () => {
    const svg = svgOf(crossingDimensions());
    const group = /<g id="world-axes"[^>]*>([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? '';
    const axes = [...group.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)];
    expect(axes).toHaveLength(3);
    const point = (x: string | undefined, y: string | undefined): [number, number] => [Number(x), Number(y)];
    const triad = triadBox({ origin: point(axes[0]?.[1], axes[0]?.[2]), tips: axes.map((axis) => point(axis[3], axis[4])) }, 800, 600);
    expect(triad).not.toBeNull();
    for (const label of dimensionLabels(svg)) expect(boxesOverlap(label.box, triad!)).toBe(false);
  });

  it('moves a colliding label to the nearest free spot and leaves a free label alone', () => {
    const box = textBox(100, 100, ['100.000'], 12, -0.3, 'middle', 0);
    const [first, second, free] = placeLabels(
      [
        { box, along: [1, 0], fontPx: 12 },
        { box, along: [1, 0], fontPx: 12 },
        { box: textBox(400, 400, ['5'], 12, -0.3, 'middle', 0), along: [1, 0], fontPx: 12 },
      ],
      [],
    );
    expect(first).toEqual([0, 0]);
    expect(second).not.toEqual([0, 0]);
    const [dx, dy] = second ?? [0, 0];
    expect(boxesOverlap(box, { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy })).toBe(false);
    expect(free).toEqual([0, 0]);
  });

  it('gives up (shift 0) when the label is boxed in, and bounds the box of rotated text', () => {
    const wall = { minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 };
    const [stuck] = placeLabels([{ box: textBox(0, 0, ['x'], 12, 0, 'start', 0), along: [1, 0], fontPx: 12 }], [wall]);
    expect(stuck).toEqual([0, 0]);
    const flat = textBox(0, 0, ['abcd'], 10, 0, 'end', 0);
    const turned = textBox(0, 0, ['abcd'], 10, 0, 'end', 90);
    expect(flat.maxX - flat.minX).toBeGreaterThan(flat.maxY - flat.minY);
    expect(turned.maxY - turned.minY).toBeGreaterThan(turned.maxX - turned.minX);
    expect(triadBox({ origin: [-500, 0], tips: [] }, 800, 600)).toBeNull();
  });
});

describe('angular dimension arc', () => {
  it('scales the default arc radius with the arm length but honours an explicit offset', () => {
    const doc = crossingDimensions();
    const lines = Object.values(doc.entities).filter((entity) => entity.kind === 'line' || entity.kind === 'polyline');
    const [left, , bottom] = lines;
    const reach = (offset: number): number => {
      const drawing = dimensionDrawing('angular', [bottom, left], offset);
      return Math.max(...(drawing?.segments ?? []).flatMap(([from, to]) => [Math.hypot(from[0], from[1]), Math.hypot(to[0], to[1])]));
    };
    expect(reach(5)).toBeCloseTo(24, 0);
    expect(reach(30)).toBeCloseTo(30, 0);
  });
});
