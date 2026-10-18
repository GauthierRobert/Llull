import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { annotationInk } from '@core/commands/render/annotations';
import { xy } from '../helpers/xy';

function annotated(): CadDocument {
  let doc = createEmptyDocument();
  const run = (command: string, params: object): string => {
    const result = execute(doc, command, params);
    doc = result.document;
    return result.affected[0]!;
  };
  const left = run('draw_polyline', { points: xy(0, 0, 0, 60) });
  const right = run('draw_polyline', { points: xy(100, 0, 100, 60) });
  const base = run('draw_polyline', { points: xy(0, 0, 100, 0) });
  const circle = run('draw_arc', { center: [50, 30], radius: 12.5 });
  run('add_dimension', { dimensionKind: 'linear', entityIds: [left, right], offset: 10, precision: 1, tolerance: '±0.1' });
  run('add_dimension', { dimensionKind: 'diameter', entityIds: [circle], precision: 0 });
  run('add_dimension', { dimensionKind: 'angular', entityIds: [base, left], label: 'x' });
  run('add_text', { content: 'PLATE <A> & B\nsecond line', position: [50, -15, 0], height: 5, anchor: 'center' });
  return doc;
}

const svgOf = (doc: CadDocument, params: object = {}): string =>
  (execute(doc, 'render_view', { view: 'top', width: 800, height: 600, ...params }).data as { svg: string }).svg;

describe('render_view draws dimensions and text', () => {
  const doc = annotated();

  it.each(['vector', 'raster'])('writes dimension values, tolerance and text content in %s mode', (mode) => {
    const svg = svgOf(doc, { mode });
    expect(svg).toContain('data-entity-id="dim-5.1"');
    expect(svg).toContain('>100.0 ±0.1</tspan>');
    expect(svg).toContain('>Ø25</tspan>');
    expect(svg).toContain('PLATE &lt;A&gt; &amp; B');
    expect(svg).toContain('second line');
    expect(svg).toContain('text-anchor="middle"');
  });

  it('draws dimension lines as strokes on top of the geometry (vector)', () => {
    const withDimensions = svgOf(doc, { mode: 'vector' });
    const without = svgOf({ ...doc, order: doc.order.filter((id) => doc.entities[id]?.kind !== 'dimension') }, { mode: 'vector' });
    const strokes = (svg: string): number => (svg.match(/<polyline/g) ?? []).length;
    expect(strokes(withDimensions)).toBeGreaterThan(strokes(without) + 8);
  });

  it('a label replaces the computed value; a dangling dimension draws nothing', () => {
    expect(svgOf(doc, { mode: 'vector' })).toContain('>x</tspan>');
    const dangling = { ...doc, entities: { ...doc.entities } };
    delete dangling.entities['line-1.1'];
    const svg = svgOf(dangling, { mode: 'vector' });
    expect(svg).not.toContain('data-entity-id="dim-5.1"');
  });

  it('lifts dark annotation ink on a dark background and keeps it on a light one', () => {
    expect(annotationInk('#333333', undefined)).not.toBe('#333333');
    expect(annotationInk('#333333', '#ffffff')).toBe('#333333');
    expect(annotationInk('#ffcc00', '#1a1a2e')).toBe('#ffcc00');
    expect(svgOf(doc, { mode: 'vector', background: '#ffffff' })).toContain('fill="#333333"');
  });

  it('rotated text follows its plane in the view', () => {
    const rotated = execute(doc, 'add_text', { content: 'TILT', position: [0, 0, 0], height: 4, rotation: [0, 0, Math.PI / 2] });
    expect(svgOf(rotated.document, { mode: 'vector' })).toMatch(/transform="rotate\(-90 /);
  });
});
