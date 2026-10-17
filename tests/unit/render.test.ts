import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type Entity, type MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { tessellateEntity } from '@core/commands/render/polygons';
import { catmullRomBeziers, segmentPoint } from '@core/geometry/curveSegments';
import { planeToWorld } from '@core/geometry/workPlane';
import { xy } from '../helpers/xy';
import type { PreDepthPolygon, RenderViewData } from '@core/commands/render/types';
import { MAX_POLYGONS, applyBudget } from '@core/commands/render/budget';
import { cutEntityPolygons, surviving, unitPlanes } from '@core/commands/render/clip';
import { expectNoOp } from '../helpers/expectNoOp';
import { centroid3, dot3, sub3 } from '@lib/vec3';
import { boxInstance } from '../helpers/boxInstance';
import { deriveQualityTier, resolveQualityTier } from '@ui/viewport/3d/useRenderQuality';

type Vec3 = [number, number, number];

/** Screen-space [width, height] of every `points="…"` in the SVG (polygons + polylines). */
function svgSize(svg: string): [number, number] {
  const pts = [...svg.matchAll(/points="([^"]*)"/g)].flatMap((m) =>
    m[1]!
      .trim()
      .split(/\s+/)
      .map((p) => p.split(',').map(Number)),
  );
  const valid = pts.filter((p) => p.length === 2 && !p.some(Number.isNaN));
  expect(valid.length).toBeGreaterThan(0);
  const xs = valid.map((p) => p[0]!);
  const ys = valid.map((p) => p[1]!);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** Front-view (or `view`) SVG of one solid at the origin, optionally rotated by `delta`. */
function renderSolid(command: string, params: object, delta?: Vec3, view = 'front'): string {
  let doc = execute(createEmptyDocument(), command, { ...params, position: [0, 0, 0] }).document;
  if (delta) doc = execute(doc, 'rotate_entity', { id: doc.order[0]!, delta }).document;
  return (execute(doc, 'render_view', { mode: 'vector', view, width: 400, height: 400 }).data as { svg: string }).svg;
}

const QUARTER_X: Vec3 = [Math.PI / 2, 0, 0];

describe('render_view honours entity rotation (Rx·Ry·Rz, three.js XYZ)', () => {
  it.each<[string, object, Vec3, 0 | 1, number]>([
    ['add_cylinder', { radius: 1, height: 4 }, QUARTER_X, 1, 10],
    ['add_box', { size: [1, 1, 4] }, QUARTER_X, 1, 10],
    ['add_torus', { ringRadius: 2, tubeRadius: 0.5 }, QUARTER_X, 1, 5],
    ['add_cone', { radius: 1, height: 4 }, QUARTER_X, 1, 10],
    ['add_pyramid', { baseWidth: 2, baseDepth: 2, height: 4 }, QUARTER_X, 1, 5],
    ['add_wedge', { size: [1, 4, 1] }, [0, 0, Math.PI / 2], 0, 5],
  ])('%s rotated %j changes the front-view extent', (command, params, delta, axis, minDiff) => {
    const a = svgSize(renderSolid(command, params));
    const b = svgSize(renderSolid(command, params, delta));
    expect(Math.abs(a[axis] - b[axis])).toBeGreaterThan(minDiff);
  });

  it.each<[string, object, number]>([
    ['add_cylinder', { radius: 1, height: 4 }, 2],
    ['add_box', { size: [1, 1, 4] }, 1.5],
  ])('tall %s seen front-on turns ~square once its axis points into the camera', (command, params, maxRatio) => {
    const [w, h] = svgSize(renderSolid(command, params));
    expect(h).toBeGreaterThan(w);
    const [rw, rh] = svgSize(renderSolid(command, params, QUARTER_X));
    expect(rh / rw).toBeLessThan(maxRatio);
    if (command === 'add_cylinder') expect(rw / rh).toBeGreaterThan(0.5);
  });

  it.each([
    ['add_cylinder', { radius: 1, height: 2 }],
    ['add_box', { size: [2, 3, 4] }],
  ])('%s with a zero rotation renders identically', (command, params) =>
    expect(renderSolid(command, params, [0, 0, 0], 'iso')).toBe(renderSolid(command, params, undefined, 'iso')),
  );

  it('compound rotations follow Rx·Ry·Rz: applyEulerXYZ and a thin box turned [π/2, π/2, 0]', () => {
    for (const [v, euler, expected] of [
      [
        [0, 0, 1],
        [Math.PI / 2, Math.PI / 2, 0],
        [1, 0, 0],
      ],
      [
        [1, 0, 0],
        [0, Math.PI / 2, Math.PI / 2],
        [0, 1, 0],
      ],
    ] as Array<[Vec3, Vec3, Vec3]>) {
      const r = applyEulerXYZ(v, [0, 0, 0], euler);
      expected.forEach((e, i) => expect(Math.abs(r[i]! - e)).toBeLessThan(1e-10));
    }
    const [w, h] = svgSize(renderSolid('add_box', { size: [100, 4, 4] }, [Math.PI / 2, Math.PI / 2, 0]));
    expect(w / h).toBeGreaterThan(0.5);
    expect(w / h).toBeLessThan(2.0);
  });
});

const QUARTER_TURN = Math.PI / 2;

/** Draws one entity; `rotation` (not a draw param) is written onto it afterwards. */
function draw(
  command: string,
  params: Record<string, unknown>,
  rotation: [number, number, number] = [0, 0, 0],
): { doc: CadDocument; entity: Entity } {
  const result = execute(createEmptyDocument(), command, params);
  const id = result.affected[0] as string;
  const entity = { ...(result.document.entities[id] as Entity), rotation };
  return { doc: { ...result.document, entities: { [id]: entity } }, entity };
}

describe('planeToWorld', () => {
  it('rotates about the plane origin then translates', () => {
    const world = planeToWorld([5, 0, 1], [0, 0, QUARTER_TURN], [2, 0]);
    expect(world[0]).toBeCloseTo(5, 12);
    expect(world[1]).toBeCloseTo(2, 12);
    expect(world[2]).toBeCloseTo(1, 12);
  });
});

describe('render stroke placement honours the work-plane rotation', () => {
  it('rotates a polyline', () => {
    const { entity } = draw('draw_polyline', { points: xy(0, 0, 2, 0) }, [0, 0, QUARTER_TURN]);
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    expect(verts[1]?.[0]).toBeCloseTo(0, 12);
    expect(verts[1]?.[1]).toBeCloseTo(2, 12);
  });
  it('rotates a rectangle', () => {
    const { entity } = draw('draw_rectangle', { width: 3, height: 1 }, [0, 0, QUARTER_TURN]);
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    expect(verts[1]?.[0]).toBeCloseTo(0, 12);
    expect(verts[1]?.[1]).toBeCloseTo(3, 12);
    expect(verts).toHaveLength(5);
  });
  it('places label markers on the rotated shape', () => {
    const labelled = { width: 300, height: 200, showAxes: false, showGrid: false, showLabels: true };
    const rotated = draw('draw_polyline', { points: xy(0, 0, 2, 0) }, [0, 0, QUARTER_TURN]);
    const upright = draw('draw_polyline', { points: xy(0, 0, 0, 2) });
    const dots = (doc: CadDocument): string[] => {
      const svg = (execute(doc, 'render_view', { mode: 'vector', view: 'top', ...labelled }).data as { svg: string }).svg;
      return [...svg.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => `${m[1]},${m[2]}`);
    };
    const expected = dots(upright.doc);
    expect(expected.length).toBeGreaterThan(0);
    expect(dots(rotated.doc)).toEqual(expected);
  });
});

describe('spline stroke', () => {
  it('follows the centripetal Catmull-Rom curve of the entity', () => {
    const points = xy(0, 0, 1, 0, 10, 0.5, 11, 5);
    const { entity } = draw('draw_spline', { points });
    const verts = tessellateEntity(entity)[0]?.verts ?? [];
    const curve = catmullRomBeziers(points as [number, number][], false);
    expect(verts).toHaveLength(curve.length * 8 + 1);
    const mid = segmentPoint(curve[1]!, 0.5);
    expect(verts[8 + 4]?.[0]).toBeCloseTo(mid[0], 9);
    expect(verts[8 + 4]?.[1]).toBeCloseTo(mid[1], 9);
  });
});

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
  return { ...base, entities: { ...base.entities, [id]: mesh }, order: [...base.order, id] };
}

function render(doc: CadDocument, params: Record<string, unknown> = {}): RenderViewData {
  const result = execute(doc, 'render_view', { mode: 'vector', ...bare, ...params });
  expectNoOp(result, doc);
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
    const result = execute(doc, 'render_view', { mode: 'vector', ...bare });
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
    const result = execute(doc, 'render_view', { mode: 'vector', ...bare, maxPolygons: 500 });
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
    const poly = (stroke: boolean): PreDepthPolygon => ({ verts: [], color: '#fff', normal: [0, 0, 1], stroke });
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
    const result = execute(doc, 'render_view', { mode: 'vector', ...bare, cut: { planes: [{ normal: [1, 0, 0], offset: 0 }] } });
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
    const data = render(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: -50 }], entityIds: [second] } });
    expect(data.cutEntityIds).toEqual([second]);
  });
  it('removes a solid that lies fully on the cut side and leaves one fully outside whole', () => {
    const { doc } = boxDoc();
    const gone = render(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: -5 }] } });
    expect(gone.polygonCount).toBe(0);
    const whole = render(doc, { cut: { planes: [{ normal: [1, 0, 0], offset: 5 }] } });
    expect(whole.polygonCount).toBe(6);
    expect(whole.cutEntityIds).toEqual([]);
    const result = execute(doc, 'render_view', { mode: 'vector', ...bare, cut: { planes: [{ normal: [1, 0, 0], offset: 5 }] } });
    expect(result.summary).toContain('removed nothing');
  });
  it('cut works with isolate and turntable', () => {
    const { doc, id } = boxDoc();
    const cut = { planes: [{ normal: [1, 0, 0], offset: 0 }] };
    const isolated = execute(doc, 'render_view', { mode: 'vector', ...bare, cut, isolate: id });
    expect((isolated.data as RenderViewData).svg).toContain('ISOLATED');
    const strip = execute(doc, 'render_view', { mode: 'vector', ...bare, cut, turntable: { frames: 3 } });
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
      const result = execute(doc, 'render_view', { mode: 'vector', ...bare, cut });
      expectNoOp(result, doc);
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
      return quads.map((q) => ({ verts: q.map((i) => c[i] as P3), color: '#888888', normal: [0, 0, 1], stroke: false }));
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
      const result = execute(doc, 'render_view', { mode: 'vector', ...bare, ...params });
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(message);
      expect(result.data).toBeUndefined();
    }
  });
  it('keeps isolate layers aligned to the full scene and transparent over the background', () => {
    const first = boxDoc();
    const doc = addBox(first.doc, [10, 0, 0], '#ff8800');
    const result = execute(doc, 'render_view', { mode: 'vector', ...bare, isolate: first.id, background: '#ffffff' });
    const svg = (result.data as RenderViewData).svg;
    expect(svg.match(/<rect width="400" height="300"/g)).toHaveLength(1);
  });
});

const bare2 = { showAxes: false, showGrid: false } as const;

function boxDoc2(): { doc: CadDocument; boxId: string } {
  const result = execute(createEmptyDocument(), 'add_box', { position: [0, 0, 0], size: [2, 2, 2], color: '#336699' });
  return { doc: result.document, boxId: result.affected[0] as string };
}

function render2(doc: CadDocument, params: Record<string, unknown>): RenderViewData {
  const result = execute(doc, 'render_view', { mode: 'vector', width: 300, height: 200, ...params });
  expectNoOp(result, doc);
  return result.data as RenderViewData;
}

describe('render_view overlays', () => {
  it('draws world axes and ground grid by default, none when both are false', () => {
    const { doc } = boxDoc2();
    const withDefaults = render2(doc, {}).svg;
    expect(withDefaults).toContain('id="world-axes"');
    expect(withDefaults).toContain('id="ground-grid"');
    expect(withDefaults).toMatch(/\d+(\.\d+)? mm = [\d.]+ px/);
    const plain = render2(doc, bare2).svg;
    expect(plain).not.toContain('id="world-axes"');
    expect(plain).not.toContain('id="ground-grid"');
  });
  it.each(['top', 'front', 'iso'] as const)('axes and grid work in the %s view', (view) => {
    const { doc } = boxDoc2();
    expect(render2(doc, { view }).svg).toContain('id="ground-grid"');
  });
  it('uses document units in the scale label and tolerates an empty document', () => {
    const empty = { ...createEmptyDocument(), units: 'in' as const };
    expect(render2(empty, {}).svg).toContain(' in = ');
  });
  it('showDimensions adds W/D/H of the bounding box; empty scene adds nothing', () => {
    const { doc } = boxDoc2();
    const svg = render2(doc, { ...bare2, showDimensions: true }).svg;
    for (const s of ['W:2', 'D:2', 'H:2']) expect(svg).toContain(s);
    expect(render2(createEmptyDocument(), { ...bare2, showDimensions: true }).svg).not.toContain('W:');
  });
  it('showLabels marks 3D solids, 2D shapes, names and a legend', () => {
    let { doc } = boxDoc2();
    const draws: [string, Record<string, unknown>][] = [
      ['draw_polyline', { points: xy(0, 0, 4, 0) }],
      ['draw_arc', { center: [0, 0], radius: 1 }],
      ['draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: 1.5 }],
      ['draw_arc', { center: [0, 0], radius: 2, startAngle: 0, endAngle: 1.5 }],
      ['draw_rectangle', { width: 2, height: 1 }],
    ];
    for (const [name, params] of draws) doc = execute(doc, name, params).document;
    const svg = render2(doc, { ...bare2, showLabels: true }).svg;
    expect(svg).toContain('entity-labels-legend');
    expect(svg).toContain('data-kind="box"');
    for (const kind of ['line', 'circle', 'ellipse', 'arc', 'rectangle']) {
      expect(svg).toContain(`data-kind="${kind}"`);
    }
    expect(svg).toContain('#bb88ff');
    expect(svg).toContain('#44ddff');
    expect(render2(doc, bare2).svg).not.toContain('entity-labels-legend');
  });
  it('showLabels works on an empty document', () => {
    expect(render2(createEmptyDocument(), { ...bare2, showLabels: true }).svg).toContain('</svg>');
  });
});

describe('render_view turntable', () => {
  it('stitches N frames into one strip and reports the strip width', () => {
    const { doc } = boxDoc2();
    const result = execute(doc, 'render_view', { mode: 'vector', width: 200, height: 150, turntable: { frames: 4 } });
    const data = result.data as RenderViewData;
    expect(data.width).toBe(800);
    expect(data.height).toBe(150);
    expect(data.svg.match(/translate\(/g)).toHaveLength(4);
    expect(data.svg).toContain('270°');
    expect(result.summary).toContain('4 frame(s)');
  });
  it('clamps frames to [1, 12] and handles an empty document', () => {
    expect(render2(createEmptyDocument(), { turntable: { frames: 99 } }).width).toBe(300 * 12);
    expect(render2(boxDoc2().doc, { turntable: { frames: 0 } }).width).toBe(300);
  });
});

describe('render_view isolate and section', () => {
  it('isolate dims the others and captions the highlighted ids (string or array)', () => {
    const { doc, boxId } = boxDoc2();
    const other = execute(doc, 'add_box', { position: [5, 0, 0], size: [1, 1, 1] }).document;
    for (const isolate of [boxId, [boxId]]) {
      const result = execute(other, 'render_view', { mode: 'vector', isolate, ...bare2 });
      const svg = (result.data as RenderViewData).svg;
      expect(svg).toContain('opacity="0.15"');
      expect(svg).toContain(`ISOLATED: ${boxId}`);
      expect(result.summary).toContain('1 entity/entities highlighted');
    }
    expect(render2(createEmptyDocument(), { isolate: ['x'] }).svg).toContain('</svg>');
  });
  it.each(['x', 'y', 'z'] as const)('section cuts along %s with a plane line and label', (axis) => {
    const { doc } = boxDoc2();
    const other = execute(doc, 'add_box', { position: [5, 5, 5], size: [1, 1, 1] }).document;
    const result = execute(other, 'render_view', { mode: 'vector', section: { axis, offset: 2 }, ...bare2 });
    const svg = (result.data as RenderViewData).svg;
    expect(svg).toContain('id="section-plane"');
    expect(svg).toContain(`SECTION ${axis.toUpperCase()}=2`);
    expect(svg).toContain('opacity="0.25"');
    expect(result.summary).toContain(`cut at ${axis}=2`);
  });
  it('section works on an empty document', () => {
    expect(render2(createEmptyDocument(), { section: { axis: 'z', offset: 0 } }).svg).toContain('section-plane');
  });
  it('rejects an invalid section axis without touching the document', () => {
    const { doc } = boxDoc2();
    expectNoOp(execute(doc, 'render_view', { mode: 'vector', section: { axis: 'w', offset: 0 } }), doc, 'rejected');
  });
});

describe('render_view label markers and axes (ported from server enrichment tests)', () => {
  const labelled = { ...bare2, showLabels: true } as const;
  const markerCount = (svg: string, id: string): number => {
    const group = svg.match(new RegExp(`data-entity-id="${id}"[\\s\\S]*?</g>`))?.[0];
    expect(group).toBeDefined();
    return group?.match(/<circle[^>]+r="3"/g)?.length ?? 0;
  };
  it.each([
    ['box (8 AABB corners)', 'add_box', { position: [0, 0, 0], size: [2, 2, 2] }, 8],
    ['line (2 endpoints)', 'draw_polyline', { points: xy(0, 0, 3, 3) }, 2],
    ['circle (center + radius handle)', 'draw_arc', { center: [1, 2], radius: 1.5 }, 2],
    ['ellipse (center + 2 semi-axes)', 'draw_ellipse', { center: [0, 0], radiusX: 3, radiusY: 1.5 }, 3],
    ['arc (center + on-curve handle)', 'draw_arc', { center: [0, 0], radius: 2, startAngle: Math.PI / 2, endAngle: Math.PI }, 2],
    ['rectangle (4 corners)', 'draw_rectangle', { position: [0, 0], width: 4, height: 3 }, 4],
  ])('%s', (_label, command, params, expected) => {
    const created = execute(createEmptyDocument(), command, params);
    const id = created.affected[0] as string;
    const svg = render2(created.document, labelled).svg;
    expect(svg).toContain(id);
    expect(markerCount(svg, id)).toBe(expected);
  });
  it('labels with the entity name when set, otherwise the id', () => {
    const { doc, boxId } = boxDoc2();
    expect(render2(doc, labelled).svg).toContain(`>${boxId}</text>`);
    const named = execute(doc, 'set_entity_name', { id: boxId, name: 'MySpecialBox' }).document;
    const svg = render2(named, labelled).svg;
    expect(svg).toContain('>MySpecialBox</text>');
    expect(svg).not.toContain(`>${boxId}</text>`);
  });
  it('draws X=red, Y=green, Z=blue axes with X/Y/Z labels', () => {
    const svg = render2(boxDoc2().doc, { showAxes: true, showGrid: false }).svg;
    for (const color of ['#ff4444', '#44dd44', '#4488ff']) expect(svg).toContain(color);
    for (const axis of ['X', 'Y', 'Z']) expect(svg).toContain(`>${axis}</text>`);
  });
  it('composes axes, grid and labels in one render', () => {
    const { doc, boxId } = boxDoc2();
    const svg = render2(doc, { showAxes: true, showGrid: true, showLabels: true }).svg;
    for (const s of ['id="world-axes"', 'id="ground-grid"', 'entity labels overlay']) expect(svg).toContain(s);
    expect(svg).toContain(boxId);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
  });
  it('section plane line is dashed and the far side is dimmed', () => {
    const svg = render2(boxDoc2().doc, { ...bare2, section: { axis: 'z', offset: 10 } }).svg;
    for (const s of ['stroke-dasharray', 'opacity="0.25"', 'SECTION Z=10']) expect(svg).toContain(s);
  });
});

describe('render_view hide2D and scale label', () => {
  it('hide2D drops 2D entities from drawing, count and framing; default keeps them', () => {
    const { doc } = boxDoc2();
    const sketched = execute(doc, 'draw_polyline', { points: xy(100, 100, 200, 200) }).document;
    const shown = render2(sketched, bare2);
    expect(shown.entityCount).toBe(2);
    expect(shown.bounds?.max[0]).toBeGreaterThan(50);
    const hidden = render2(sketched, { ...bare2, hide2D: true });
    expect(hidden.entityCount).toBe(1);
    expect(hidden.bounds?.max).toEqual([1, 1, 1]);
    expect(Object.keys(sketched.entities)).toHaveLength(2);
  });
  it.each(['left', 'right', 'front', 'top'] as const)('scale label shows a non-zero pixel length in the %s view', (view) => {
    const { doc } = boxDoc2();
    const match = /mm = ([\d.]+) px/.exec(render2(doc, { view }).svg);
    expect(Number(match?.[1])).toBeGreaterThan(0);
  });
});

/** The single entity a primitive command adds to an empty document. */
function added(command: string, params: Record<string, unknown>): Entity {
  const doc = execute(createEmptyDocument(), command, params).document;
  const id = doc.order[0];
  if (id === undefined) throw new Error(`${command} added nothing`);
  const entity = doc.entities[id];
  if (entity === undefined) throw new Error(`${command} lost ${id}`);
  return entity;
}

// render_view Lambert-shades each face by its normal: an inward normal lights the hidden back
// faces and leaves the visible top / front at ambient.
describe('render_view face normals', () => {
  it.each([
    ['add_box', { size: [4, 3, 2], position: [10, -5, 1] }],
    ['add_wedge', { size: [4, 3, 2], position: [10, -5, 1] }],
  ])('%s faces point away from the solid', (command, params) => {
    const polygons = tessellateEntity(added(command, params));
    expect(polygons.length).toBeGreaterThan(0);
    const center = centroid3(polygons.flatMap((polygon) => polygon.verts));
    for (const polygon of polygons) {
      const outward = sub3(centroid3(polygon.verts), center);
      expect(dot3(polygon.normal, outward)).toBeGreaterThan(0);
    }
  });
});

const svgOf = (doc: CadDocument, params: Record<string, unknown> = {}): string =>
  (execute(doc, 'render_view', { mode: 'vector', ...params }).data as { svg: string }).svg;

const shapeCount = (svg: string): number => (svg.match(/<polygon|<path|<polyline/g) ?? []).length;

describe('render_view draws component instances', () => {
  const { doc, instanceId } = boxInstance([5, 0, 0]);
  it('an assembly-only document renders its component geometry', () => {
    const empty = svgOf(createEmptyDocument());
    expect(shapeCount(svgOf(doc))).toBeGreaterThan(shapeCount(empty));
    expect(doc.order).toContain(instanceId);
  });
  it('a scaled instance covers more of the view than the unit-scale one', () => {
    const scaled = execute(doc, 'move_entities', { ids: [instanceId], delta: [0, 0, 0] }).document;
    const bigger: CadDocument = {
      ...scaled,
      entities: { ...scaled.entities, [instanceId]: { ...scaled.entities[instanceId]!, scale: [3, 3, 3] } as never },
    };
    expect(svgOf(bigger)).not.toBe(svgOf(doc));
  });
  it('a missing component and a self-referencing component do not throw or loop', () => {
    const broken: CadDocument = { ...doc, components: {} };
    expect(svgOf(broken)).toContain('<svg');
    const cyclic: CadDocument = {
      ...doc,
      components: {
        'comp-part': { ...doc.components['comp-part']!, entities: { [instanceId]: doc.entities[instanceId]! }, order: [instanceId] },
      },
    };
    expect(svgOf(cyclic)).toContain('<svg');
  });
  it('no NaN or Infinity leaks into the SVG', () => {
    expect(svgOf(doc, { view: 'front' })).not.toMatch(/NaN|Infinity/);
  });
});

describe('render_view — large mesh', () => {
  it('renders a 200k-triangle mesh (capped) instead of overflowing the call stack', () => {
    const triangles = 200_000;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let t = 0; t < triangles; t++) {
      const x = t % 500;
      const y = Math.floor(t / 500);
      positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0);
      indices.push(3 * t, 3 * t + 1, 3 * t + 2);
    }
    const doc = createEmptyDocument();
    const mesh = {
      id: 'mesh-big',
      kind: 'mesh' as const,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      layerId: 'layer-default',
      color: '#ffffff',
      mesh: { positions, indices },
    };
    const withMesh = { ...doc, entities: { ...doc.entities, [mesh.id]: mesh }, order: [...doc.order, mesh.id] };
    const result = execute(withMesh, 'render_view', { mode: 'vector' });
    expect(result.summary).not.toMatch(/failed/);
    expect(result.data).toMatchObject({ entityCount: 1 });
  });
});

describe('render quality tiers', () => {
  it.each([
    [0, 'high'],
    [1, 'high'],
    [10, 'high'],
    [50, 'high'],
    [51, 'medium'],
    [100, 'medium'],
    [200, 'medium'],
    [201, 'low'],
    [500, 'low'],
    [1000, 'low'],
  ] as const)('%i entities → %s (auto)', (count, tier) => {
    expect(deriveQualityTier(count)).toBe(tier);
    expect(resolveQualityTier('auto', count)).toBe(tier);
  });

  it.each([
    ['high', 500],
    ['medium', 0],
    ['low', 1],
  ] as const)('an explicit %s override ignores the entity count (%i)', (tier, count) => expect(resolveQualityTier(tier, count)).toBe(tier));
});
