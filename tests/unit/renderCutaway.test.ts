/** render_view: fair polygon budget, cutaway, camera/title/background options. */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { PreDepthPolygon, RenderViewData } from '@core/commands/render/types';
import { MAX_POLYGONS, applyBudget } from '@core/commands/render/budget';
import { cutEntityPolygons, surviving, unitPlanes } from '@core/commands/render/clip';

const bare = { showAxes: false, showGrid: false, width: 400, height: 300 } as const;

function addBox(doc: CadDocument, position: [number, number, number], color: string): CadDocument {
  return execute(doc, 'add_box', { position, size: [2, 2, 2], color }).document;
}

function meshDoc(id: string, triangles: number, x0: number, base: CadDocument): CadDocument {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const x = x0 + (t % 400) * 0.01;
    const y = Math.floor(t / 400) * 0.01;
    positions.push(x, y, 0, x + 0.01, y, 0, x, y + 0.01, 0.01);
    indices.push(3 * t, 3 * t + 1, 3 * t + 2);
  }
  const mesh: MeshSolidEntity = {
    id,
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
    mesh: { positions, indices },
  };
  return {
    ...base,
    entities: { ...base.entities, [id]: mesh },
    order: [...base.order, id],
  };
}

function render(doc: CadDocument, params: Record<string, unknown> = {}): RenderViewData {
  const result = execute(doc, 'render_view', { ...bare, ...params });
  expect(result.affected).toEqual([]);
  expect(result.document).toBe(doc);
  return result.data as RenderViewData;
}

function boxDoc(): { doc: CadDocument; id: string } {
  const doc = addBox(createEmptyDocument(), [0, 0, 0], '#336699');
  return { doc, id: doc.order[0] as string };
}

describe('render_view polygon budget', () => {
  it('keeps later entities visible when the first entity alone exceeds the budget', () => {
    const big = meshDoc('big', MAX_POLYGONS + 5000, 0, createEmptyDocument());
    const doc = addBox(big, [50, 0, 0], '#ff0000');
    const result = execute(doc, 'render_view', bare);
    const data = result.data as RenderViewData;

    expect(data.simplifiedEntityIds).toEqual(['big']);
    expect(data.skippedEntityIds).toEqual([]);
    expect(data.polygonCount).toBeLessThanOrEqual(MAX_POLYGONS);
    expect(data.svg).toMatch(/fill="rgb\(\d+,0,0\)"/);
    expect(result.summary).toContain('Simplified 1 entity');
    expect(result.summary).toContain('big');
  });

  it('reports skipped entities when the budget is smaller than the entity count', () => {
    let doc = createEmptyDocument();
    for (let i = 0; i < 520; i++) doc = meshDoc(`m${i}`, 1, i, doc);
    const result = execute(doc, 'render_view', { ...bare, maxPolygons: 500 });
    const data = result.data as RenderViewData;

    expect(data.polygonCount).toBe(500);
    expect(data.skippedEntityIds).toHaveLength(20);
    expect(result.summary).toContain('NOT drawn');
  });

  it('draws everything untouched under the budget', () => {
    const { doc } = boxDoc();
    const data = render(doc);
    expect(data.simplifiedEntityIds).toEqual([]);
    expect(data.skippedEntityIds).toEqual([]);
    expect(data.polygonCount).toBe(6);
  });

  it('applyBudget water-fills: small entities stay whole, never-dropped strokes survive', () => {
    const poly = (stroke: boolean): PreDepthPolygon => ({
      verts: [],
      color: '#fff',
      normal: [0, 0, 1],
      stroke,
    });
    const many = Array.from({ length: 100 }, () => poly(false));
    const result = applyBudget(
      [
        { id: 'a', polygons: many },
        { id: 'b', polygons: [poly(false), poly(false)] },
        { id: 'c', polygons: [poly(true)] },
      ],
      30,
    );
    expect(result.simplifiedEntityIds).toEqual(['a']);
    expect(result.polygons.filter((p) => !p.stroke)).toHaveLength(30);
    expect(result.polygons.filter((p) => p.stroke)).toHaveLength(1);
  });
});

describe('render_view cutaway', () => {
  const quadrant = {
    planes: [
      { normal: [1, 0, 0], offset: 0 },
      { normal: [0, -1, 0], offset: 0 },
    ],
  };

  it('splits box faces and adds one hatched cap for a single plane', () => {
    const { doc, id } = boxDoc();
    const result = execute(doc, 'render_view', {
      ...bare,
      cut: { planes: [{ normal: [1, 0, 0], offset: 0 }] },
    });
    const data = result.data as RenderViewData;
    // left face + 4 clipped side faces + cap
    expect(data.polygonCount).toBe(6);
    expect(data.cutEntityIds).toEqual([id]);
    expect(data.svg).toContain('llull-hatch');
    expect(data.svg).toContain('CUTAWAY (intersection, 1 plane(s))');
    expect(result.summary).toContain('Cutaway');
  });

  it('removes only the quadrant where all planes overlap in intersection mode', () => {
    const { doc, id } = boxDoc();
    const data = render(doc, { cut: quadrant });
    expect(data.cutEntityIds).toEqual([id]);
    // L-shaped notch: 3 caps would need 2 planes -> 2 caps; both present
    expect(data.svg.match(/fill="url\(#llull-hatch\)"/g)).toHaveLength(2);
  });

  it('union mode removes more than intersection', () => {
    const { doc } = boxDoc();
    const intersection = render(doc, { cut: { ...quadrant, mode: 'intersection' } });
    const union = render(doc, { cut: { ...quadrant, mode: 'union' } });
    expect(union.polygonCount).toBeLessThan(intersection.polygonCount + 1);
    expect(union.cutEntityIds).toHaveLength(1);
  });

  it('only cuts the selected entities', () => {
    const first = boxDoc();
    const doc = addBox(first.doc, [10, 0, 0], '#00ff00');
    const second = doc.order[1] as string;
    const data = render(doc, {
      cut: { planes: [{ normal: [1, 0, 0], offset: -50 }], entityIds: [second] },
    });
    expect(data.cutEntityIds).toEqual([second]);
  });

  it('removes a solid that lies fully on the cut side and leaves one fully outside whole', () => {
    const { doc } = boxDoc();
    const gone = render(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: -5 }] } });
    expect(gone.polygonCount).toBe(0);
    const whole = render(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: 5 }] } });
    expect(whole.polygonCount).toBe(6);
    expect(whole.cutEntityIds).toEqual([]);
    const result = execute(doc, 'render_view', {
      ...bare,
      cut: { planes: [{ normal: [1, 0, 0], offset: 5 }] },
    });
    expect(result.summary).toContain('removed nothing');
  });

  it('cut works with isolate and turntable', () => {
    const { doc, id } = boxDoc();
    const cut = { planes: [{ normal: [1, 0, 0], offset: 0 }] };
    const isolated = execute(doc, 'render_view', { ...bare, cut, isolate: id });
    expect((isolated.data as RenderViewData).svg).toContain('ISOLATED');
    const strip = execute(doc, 'render_view', { ...bare, cut, turntable: { frames: 3 } });
    expect((strip.data as RenderViewData).svg).toContain('llull-hatch');
  });

  it('rejects invalid cut input without touching the document', () => {
    const { doc } = boxDoc();
    const bad: [string, unknown, RegExp][] = [
      ['zero normal', { planes: [{ normal: [0, 0, 0], offset: 1 }] }, /non-zero/],
      ['no planes', { planes: [] }, /1\.\.6 planes/],
      ['too many planes', { planes: Array(7).fill({ normal: [1, 0, 0], offset: 0 }) }, /planes/],
      ['empty selection', { planes: [{ normal: [1, 0, 0], offset: 0 }], entityIds: [] }, /entityIds is empty/],
      ['unknown ids', { planes: [{ normal: [1, 0, 0], offset: 0 }], entityIds: ['nope'] }, /matches no entity/],
    ];
    for (const [, cut, message] of bad) {
      const result = execute(doc, 'render_view', { ...bare, cut });
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(message);
      expect(result.data).toBeUndefined();
    }
  });

  it('surviving() splits a triangle exactly and caps concentric shells with two loops', () => {
    const planes = unitPlanes({ planes: [{ normal: [2, 0, 0], offset: 2 }], mode: 'union' });
    expect(planes[0]).toEqual({ normal: [1, 0, 0], offset: 1 });
    const triangle: [number, number, number][] = [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ];
    const kept = surviving(triangle, planes, 'union');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toHaveLength(4);
    expect(Math.max(...(kept[0] ?? []).map((v) => v[0]))).toBeCloseTo(1);

    type P3 = [number, number, number];
    const shell = (h: number): PreDepthPolygon[] => {
      const c: P3[] = [
        [-h, -h, -h],
        [h, -h, -h],
        [h, h, -h],
        [-h, h, -h],
        [-h, -h, h],
        [h, -h, h],
        [h, h, h],
        [-h, h, h],
      ];
      const quads = [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [1, 2, 6, 5],
        [3, 0, 4, 7],
      ];
      return quads.map((q) => ({
        verts: q.map((i) => c[i] as P3),
        color: '#888888',
        normal: [0, 0, 1],
        stroke: false,
      }));
    };
    const tube = [...shell(2), ...shell(1)];
    const cut = { planes: [{ normal: [1, 0, 0] as [number, number, number], offset: 0 }] };
    const result = cutEntityPolygons(tube, { ...cut, mode: 'intersection' }, unitPlanes({ ...cut, mode: 'intersection' }), 1e-6);
    const cap = result.polygons.find((p) => p.loops !== undefined);
    expect(result.cut).toBe(true);
    expect(cap?.loops).toHaveLength(2);
  });
});

describe('render_view camera, title, background', () => {
  it('zoom shrinks the projected frustum', () => {
    const { doc } = boxDoc();
    const normal = render(doc);
    const zoomed = render(doc, { zoom: 2 });
    expect(zoomed.orthoHalf).toBeCloseTo(normal.orthoHalf / 2);
  });

  it('direction yields a custom view looking from that vector', () => {
    const { doc } = boxDoc();
    const data = render(doc, { direction: [0, 0, 5] });
    expect(data.view).toBe('custom');
    expect(data.camera.up).toEqual([0, 1, 0]);
    expect(data.camera.position[0]).toBeCloseTo(0);
    expect(data.camera.position[2]).toBeGreaterThan(0);
    const oblique = render(doc, { direction: [1, -1, 0.5], target: [1, 1, 1] });
    expect(oblique.camera.target).toEqual([1, 1, 1]);
    expect(oblique.camera.up).toEqual([0, 0, 1]);
  });

  it('draws the title top-left (escaped) and the requested background', () => {
    const { doc } = boxDoc();
    const data = render(doc, { title: 'A<B> housing', background: 'white' });
    expect(data.svg).toContain('A&lt;B&gt; housing');
    expect(data.svg).toContain('fill="white"');
    expect(render(doc).svg).toContain('fill="#1a1a2e"');
  });

  it('rejects zoom, direction and background that cannot be honored', () => {
    const { doc } = boxDoc();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ zoom: 0 }, /zoom must be > 0/],
      [{ direction: [0, 0, 0] }, /non-zero/],
      [{ background: 'url(javascript:1)' }, /not a CSS color/],
    ];
    for (const [params, message] of cases) {
      const result = execute(doc, 'render_view', { ...bare, ...params });
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(message);
      expect(result.data).toBeUndefined();
    }
  });

  it('keeps isolate layers aligned to the full scene and transparent over the background', () => {
    const first = boxDoc();
    const doc = addBox(first.doc, [10, 0, 0], '#ff8800');
    const result = execute(doc, 'render_view', {
      ...bare,
      isolate: first.id,
      background: '#ffffff',
    });
    const svg = (result.data as RenderViewData).svg;
    expect(svg.match(/<rect width="400" height="300"/g)).toHaveLength(1);
  });
});
