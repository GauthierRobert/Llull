/**
 * render_view enrichments (turntable, isolate, section, overlays) through the core command.
 * @layer tests/unit
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { RenderViewData } from '@core/commands/renderTypes';

const bare = { showAxes: false, showGrid: false } as const;

function boxDoc(): { doc: CadDocument; boxId: string } {
  const result = execute(createEmptyDocument(), 'add_box', {
    position: [0, 0, 0],
    size: [2, 2, 2],
    color: '#336699',
  });
  return { doc: result.document, boxId: result.affected[0] as string };
}

function render(doc: CadDocument, params: Record<string, unknown>): RenderViewData {
  const result = execute(doc, 'render_view', { width: 300, height: 200, ...params });
  expect(result.affected).toEqual([]);
  expect(result.document).toBe(doc);
  return result.data as RenderViewData;
}

describe('render_view overlays', () => {
  it('draws world axes and ground grid by default, none when both are false', () => {
    const { doc } = boxDoc();
    const withDefaults = render(doc, {}).svg;
    expect(withDefaults).toContain('id="world-axes"');
    expect(withDefaults).toContain('id="ground-grid"');
    expect(withDefaults).toMatch(/\d+(\.\d+)? mm = [\d.]+ px/);
    const plain = render(doc, bare).svg;
    expect(plain).not.toContain('id="world-axes"');
    expect(plain).not.toContain('id="ground-grid"');
  });

  it.each(['top', 'front', 'iso'] as const)('axes and grid work in the %s view', (view) => {
    const { doc } = boxDoc();
    expect(render(doc, { view }).svg).toContain('id="ground-grid"');
  });

  it('uses document units in the scale label and tolerates an empty document', () => {
    const empty = { ...createEmptyDocument(), units: 'in' as const };
    expect(render(empty, {}).svg).toContain(' in = ');
  });

  it('showDimensions adds W/D/H of the bounding box; empty scene adds nothing', () => {
    const { doc } = boxDoc();
    const svg = render(doc, { ...bare, showDimensions: true }).svg;
    expect(svg).toContain('W:2');
    expect(svg).toContain('D:2');
    expect(svg).toContain('H:2');
    expect(render(createEmptyDocument(), { ...bare, showDimensions: true }).svg).not.toContain(
      'W:',
    );
  });

  it('showLabels marks 3D solids, 2D shapes, names and a legend', () => {
    let { doc } = boxDoc();
    const draws: [string, Record<string, unknown>][] = [
      ['draw_line', { start: [0, 0], end: [4, 0] }],
      ['draw_circle', { center: [0, 0], radius: 1 }],
      ['draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: 1.5 }],
      ['draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: 1.5 }],
      ['draw_rectangle', { width: 2, height: 1 }],
    ];
    for (const [name, params] of draws) doc = execute(doc, name, params).document;
    const svg = render(doc, { ...bare, showLabels: true }).svg;
    expect(svg).toContain('entity-labels-legend');
    expect(svg).toContain('data-kind="box"');
    for (const kind of ['line', 'circle', 'ellipse', 'arc', 'rectangle']) {
      expect(svg).toContain(`data-kind="${kind}"`);
    }
    expect(svg).toContain('#bb88ff');
    expect(svg).toContain('#44ddff');
    expect(render(doc, bare).svg).not.toContain('entity-labels-legend');
  });

  it('showLabels works on an empty document', () => {
    expect(render(createEmptyDocument(), { ...bare, showLabels: true }).svg).toContain('</svg>');
  });
});

describe('render_view turntable', () => {
  it('stitches N frames into one strip and reports the strip width', () => {
    const { doc } = boxDoc();
    const result = execute(doc, 'render_view', {
      width: 200,
      height: 150,
      turntable: { frames: 4 },
    });
    const data = result.data as RenderViewData;
    expect(data.width).toBe(800);
    expect(data.height).toBe(150);
    expect(data.svg.match(/translate\(/g)).toHaveLength(4);
    expect(data.svg).toContain('270°');
    expect(result.summary).toContain('4 frame(s)');
  });

  it('clamps frames to [1, 12] and handles an empty document', () => {
    expect(render(createEmptyDocument(), { turntable: { frames: 99 } }).width).toBe(300 * 12);
    expect(render(boxDoc().doc, { turntable: { frames: 0 } }).width).toBe(300);
  });
});

describe('render_view isolate and section', () => {
  it('isolate dims the others and captions the highlighted ids (string or array)', () => {
    const { doc, boxId } = boxDoc();
    const other = execute(doc, 'add_box', { position: [5, 0, 0], size: [1, 1, 1] }).document;
    for (const isolate of [boxId, [boxId]]) {
      const result = execute(other, 'render_view', { isolate, ...bare });
      const svg = (result.data as RenderViewData).svg;
      expect(svg).toContain('opacity="0.15"');
      expect(svg).toContain(`ISOLATED: ${boxId}`);
      expect(result.summary).toContain('1 entity/entities highlighted');
    }
    expect(render(createEmptyDocument(), { isolate: ['x'] }).svg).toContain('</svg>');
  });

  it.each(['x', 'y', 'z'] as const)('section cuts along %s with a plane line and label', (axis) => {
    const { doc } = boxDoc();
    const other = execute(doc, 'add_box', { position: [5, 5, 5], size: [1, 1, 1] }).document;
    const result = execute(other, 'render_view', { section: { axis, offset: 2 }, ...bare });
    const svg = (result.data as RenderViewData).svg;
    expect(svg).toContain('id="section-plane"');
    expect(svg).toContain(`SECTION ${axis.toUpperCase()}=2`);
    expect(svg).toContain('opacity="0.25"');
    expect(result.summary).toContain(`cut at ${axis}=2`);
  });

  it('section works on an empty document', () => {
    expect(render(createEmptyDocument(), { section: { axis: 'z', offset: 0 } }).svg).toContain(
      'section-plane',
    );
  });

  it('rejects an invalid section axis without touching the document', () => {
    const { doc } = boxDoc();
    const result = execute(doc, 'render_view', { section: { axis: 'w', offset: 0 } });
    expect(result.summary).toContain('rejected');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });
});
