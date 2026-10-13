import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LAYER_ID,
  createEmptyDocument,
  type CadDocument,
  type Entity,
  type Vec3,
  type InstanceEntity,
  type PolylineEntity,
} from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { applyEulerXYZ, eulerFromAxes } from '@lib/eulerRotation';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';
import { xyz, xy } from '../helpers/xy';

const ORIGIN: Vec3 = [0, 0, 0];

function withLink(...extra: Array<Record<string, unknown>>): CadDocument {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [4, 1, 2] });
  const linkId = doc.affected[0] as string;
  const entities: Record<string, Entity> = { ...doc.document.entities };
  for (const shape of extra) {
    entities[shape['id'] as string] = {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#ffffff',
      ...shape,
    } as unknown as Entity;
  }
  return { ...doc.document, entities, order: [linkId, ...extra.map((shape) => shape['id'] as string)] };
}

const linkId = (doc: CadDocument): string => doc.order[0] as string;
const axis = (rotation: Vec3, local: Vec3): Vec3 => applyEulerXYZ(local, ORIGIN, rotation);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('pattern_along_path', () => {
  it('spaces copies evenly round a closed circle, local +X along the tangent', () => {
    const doc = withLink({ id: 'ring', kind: 'circle', center: [0, 0], radius: 10 });
    const result = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 8, pathId: 'ring' });
    expect(result.affected).toHaveLength(8);
    expect(result.document.entities[linkId(doc)]).toBeDefined();
    const copies = result.affected.map((id) => result.document.entities[id] as Entity);
    const chord = 2 * 10 * Math.sin(Math.PI / 8);
    copies.forEach((copy, k) => {
      expect(Math.hypot(copy.position[0], copy.position[1])).toBeCloseTo(10, 2);
      const next = copies[(k + 1) % copies.length] as Entity;
      const gap = Math.hypot(...copy.position.map((v, i) => v - (next.position[i] ?? 0)));
      expect(gap).toBeCloseTo(chord, 1);
      const radial: Vec3 = [copy.position[0] / 10, copy.position[1] / 10, 0];
      expect(Math.abs(dot(axis(copy.rotation, [1, 0, 0]), radial))).toBeLessThan(0.05);
    });
    expect(result.summary).toContain('closed path');
  });
  it('rolls each copy by rollStep about the tangent (alternating chain plates)', () => {
    const doc = withLink();
    const result = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 3,
      path: xyz(0, 0, 0, 20, 0, 0),
      rollStep: Math.PI / 2,
    });
    const [a, b] = result.affected.map((id) => result.document.entities[id] as Entity);
    expect(Math.abs(dot(axis(a!.rotation, [0, 0, 1]), axis(b!.rotation, [0, 0, 1])))).toBeLessThan(1e-9);
    expect(axis(a!.rotation, [1, 0, 0])[0]).toBeCloseTo(1, 9);
  });
  it('puts copies at both ends of an open path, or at the start for a single copy', () => {
    const doc = withLink();
    const path = xyz(0, 0, 0, 10, 0, 0, 10, 10, 0);
    const three = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 3, path });
    const ends = three.affected.map((id) => three.document.entities[id]!.position);
    expect(ends[0]).toEqual([0, 0, 0]);
    ends[2]!.forEach((v, i) => expect(v).toBeCloseTo([10, 10, 0][i] as number, 6));
    expect(three.summary).toContain('open path');
    const one = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 1, path });
    expect(one.document.entities[one.affected[0] as string]!.position).toEqual([0, 0, 0]);
  });
  it('follows smooth and closed point loops and composes with the source rotation', () => {
    const base = withLink();
    const doc = execute(base, 'rotate_entity', { id: linkId(base), delta: [0.3, 0, 0] }).document;
    const result = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 6,
      path: xyz(0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0),
      smooth: true,
      closed: true,
    });
    expect(result.affected).toHaveLength(6);
    const lines = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 4,
      path: xyz(0, 0, 0, 10, 0, 0, 10, 10, 0),
      closed: true,
    });
    expect(lines.summary).toContain('closed path');
  });
  it.each([
    ['missing source', { sourceId: 'nope', count: 2, path: xyz(0, 0, 0, 1, 0, 0) }, 'not found'],
    ['count 0', { sourceId: 'link', count: 0, path: xyz(0, 0, 0, 1, 0, 0) }, 'count must be'],
    ['no path', { sourceId: 'link', count: 2 }, 'exactly one of path, pathId or arc'],
    [
      'bad point',
      {
        sourceId: 'link',
        count: 2,
        path: [
          [0, 0, 0],
          [1, 0],
        ],
      },
      'path point 1',
    ],
    ['one point', { sourceId: 'link', count: 2, path: [[0, 0, 0]] }, 'path needs'],
    ['coincident', { sourceId: 'link', count: 2, path: xyz(0, 0, 0, 0, 0, 0) }, 'path invalid'],
    ['missing pathId', { sourceId: 'link', count: 2, pathId: 'nope' }, 'no entity'],
  ])('%s → no-op', (_label, params, text) => {
    const doc = withLink();
    const sourceId = params.sourceId === 'link' ? linkId(doc) : params.sourceId;
    expectNoOp(execute(doc, 'pattern_along_path', { ...params, sourceId }), doc, text);
  });
  it('orient:false keeps the source rotation and spaces copies by arc length', () => {
    const doc = withLink();
    const path = xyz(0, 0, 0, 10, 0, 0, 10, 10, 0);
    const result = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 3, path, orient: false });
    const copies = result.affected.map((id) => result.document.entities[id] as Entity);
    expect(copies.map((copy) => copy.rotation)).toEqual([ORIGIN, ORIGIN, ORIGIN]);
    expect(copies[1]!.position[0]).toBeCloseTo(10, 6);
    expect(copies[1]!.position[1]).toBeCloseTo(0, 6);
    expect(result.summary).not.toContain('oriented');
  });
  it('startOffset / endOffset trim an open path; startOffset alone places a single copy', () => {
    const doc = withLink();
    const path = xyz(0, 0, 0, 20, 0, 0);
    const trimmed = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 3, path, startOffset: 2, endOffset: 2 });
    const xs = trimmed.affected.map((id) => trimmed.document.entities[id]!.position[0]);
    expect(xs[0]).toBeCloseTo(2, 6);
    expect(xs[2]).toBeCloseTo(18, 6);
    const single = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 1, path, startOffset: 10 });
    expect(single.document.entities[single.affected[0] as string]!.position[0]).toBeCloseTo(10, 6);
    expectNoOp(
      execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 2, path, startOffset: 12, endOffset: 12 }),
      doc,
      'offsets',
    );
  });
  it('arc places copies on the circle: full turn spaces them evenly, one copy sits mid-sweep', () => {
    const doc = withLink();
    const arc = { center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngle: 0, endAngle: 2 * Math.PI };
    const full = execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 4, arc, orient: false });
    const angles = full.affected.map((id) => {
      const [x, y] = full.document.entities[id]!.position;
      expect(Math.hypot(x, y)).toBeCloseTo(5, 3);
      return Math.atan2(y, x);
    });
    expect(angles[0]).toBeCloseTo(0, 3);
    expect(angles[1]).toBeCloseTo(Math.PI / 2, 3);
    expect(Math.abs(angles[2]!)).toBeCloseTo(Math.PI, 3);
    const half = execute(doc, 'pattern_along_path', {
      sourceId: linkId(doc),
      count: 1,
      arc: { ...arc, endAngle: Math.PI },
      startOffset: (5 * Math.PI) / 2,
    });
    const mid = half.document.entities[half.affected[0] as string]!.position;
    expect(mid[0]).toBeCloseTo(0, 3);
    expect(mid[1]).toBeCloseTo(5, 3);
  });
  it.each([
    ['zero normal', { normal: [0, 0, 0] }, 'non-zero'],
    ['radius <= 0', { radius: 0 }, 'radius'],
    ['bad center', { center: [0, 0] }, 'center'],
  ])('arc with %s is a no-op', (_label, override, text) => {
    const doc = withLink();
    const arc = { center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngle: 0, endAngle: 3 };
    expectNoOp(execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 3, arc: { ...arc, ...override } }), doc, text);
  });
  it('refuses both an arc and a path, or neither source / both sources', () => {
    const doc = withLink();
    const arc = { center: [0, 0, 0], normal: [0, 0, 1], radius: 5, startAngle: 0, endAngle: 3 };
    const path = xyz(0, 0, 0, 1, 0, 0);
    expectNoOp(execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 2, arc, path }), doc, 'exactly one');
    expectNoOp(execute(doc, 'pattern_along_path', { count: 2, path }), doc, 'exactly one');
  });
  it('is pure', () => {
    const doc = withLink({ id: 'ring', kind: 'circle', center: [0, 0], radius: 5 });
    expectPure(doc, () => execute(doc, 'pattern_along_path', { sourceId: linkId(doc), count: 5, pathId: 'ring' }));
  });
  it('eulerFromAxes reproduces a known rotation', () => {
    const euler = eulerFromAxes([0, 1, 0], [-1, 0, 0], [0, 0, 1]);
    expect(axis(euler, [1, 0, 0])[1]).toBeCloseTo(1, 9);
  });
});

// Helpers

interface DocWithComponent {
  doc: ReturnType<typeof createEmptyDocument>;
  componentId: string;
}

/** Build a doc with a tiny component derived from a box entity. */
function buildDocWithComponent(): DocWithComponent {
  let doc = createEmptyDocument();
  const boxResult = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
  doc = boxResult.document;
  const boxId = boxResult.affected[0]!;
  const compResult = execute(doc, 'create_component', { name: 'link', entityIds: [boxId] });
  doc = compResult.document;
  const componentId = Object.keys(compResult.document.components)[0] ?? '';
  return { doc, componentId };
}

/**
 * Draw a horizontal open polyline (3 points: a 2-point series would be a `line`) from (0,0) to (length, 0) in local space,
 * placed at world origin.
 */
function drawHorizontalPolyline(
  doc: ReturnType<typeof createEmptyDocument>,
  length: number,
): { doc: ReturnType<typeof createEmptyDocument>; pathId: string } {
  const result = execute(doc, 'draw_polyline', { points: xy(0, 0, length / 2, 0, length, 0), closed: false });
  return { doc: result.document, pathId: result.affected[0]! };
}

/**
 * Draw a vertical open polyline from (0,0) to (0, length).
 */
function drawVerticalPolyline(
  doc: ReturnType<typeof createEmptyDocument>,
  length: number,
): { doc: ReturnType<typeof createEmptyDocument>; pathId: string } {
  const result = execute(doc, 'draw_polyline', { points: xy(0, 0, 0, length / 2, 0, length), closed: false });
  return { doc: result.document, pathId: result.affected[0]! };
}

/**
 * Draw a 2-pulley belt (closed polyline loop) and return the path entity id
 * plus the chord-approximated total arc length.
 */
function drawBeltLoop(doc: ReturnType<typeof createEmptyDocument>): {
  doc: ReturnType<typeof createEmptyDocument>;
  pathId: string;
  totalLength: number;
} {
  const result = execute(doc, 'draw_belt_around', {
    pulleys: [
      { center: [0, 0], radius: 5 },
      { center: [30, 0], radius: 5 },
    ],
    arcSamples: 16,
  });
  const pathId = result.affected[0]!;
  const entity = result.document.entities[pathId] as PolylineEntity;
  const pts = entity.points;
  let totalLength = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dy = pts[i]![1] - pts[i - 1]![1];
    totalLength += Math.sqrt(dx * dx + dy * dy);
  }
  // wrap-back chord (closed path)
  const dx = pts[0]![0] - pts[pts.length - 1]![0];
  const dy = pts[0]![1] - pts[pts.length - 1]![1];
  totalLength += Math.sqrt(dx * dx + dy * dy);
  return { doc: result.document, pathId, totalLength };
}

// Test suite

type Doc = ReturnType<typeof createEmptyDocument>;
type Drawn = { doc: Doc; pathId: string };

/** Doc with component + a path drawn by `draw`; returns ids and a `run(extra)` shortcut. */
function scene(draw: (doc: Doc) => Drawn = (d) => drawHorizontalPolyline(d, 10)): {
  doc: Doc;
  componentId: string;
  pathId: string;
  run: (extra: Record<string, unknown>) => ReturnType<typeof execute>;
} {
  const init = buildDocWithComponent();
  const { doc, pathId } = draw(init.doc);
  const { componentId } = init;
  return { doc, componentId, pathId, run: (extra) => execute(doc, 'pattern_along_path', { pathId, componentId, ...extra }) };
}

function expectInstances(result: ReturnType<typeof execute>, componentId: string, count: number): void {
  expect(result.affected).toHaveLength(count);
  for (const id of result.affected) {
    const inst = result.document.entities[id] as InstanceEntity;
    expect(inst.kind).toBe('instance');
    expect(inst.componentId).toBe(componentId);
  }
}

const rotations = (r: ReturnType<typeof execute>): number[][] =>
  r.affected.map((id) => [...(r.document.entities[id] as InstanceEntity).rotation]);

describe('pattern_along_path', () => {
  it('open horizontal path, count=5: creates 5 instances at evenly-spaced x positions', () => {
    const { componentId, run } = scene((d) => drawHorizontalPolyline(d, 40));
    const result = run({ count: 5 });
    expectInstances(result, componentId, 5);
    expect(result.affected.every((id) => id in result.document.entities)).toBe(true);
    const xPositions = result.affected.map((id) => result.document.entities[id]!.position[0]);
    for (let i = 1; i < xPositions.length; i++) {
      expect(xPositions[i]!).toBeGreaterThan(xPositions[i - 1]!);
    }
    expect(xPositions[0]!).toBeCloseTo(0, 6);
    expect(xPositions[4]!).toBeCloseTo(40, 6);
  });
  it('open horizontal path, count=5: all Y positions are 0', () => {
    const result = scene((d) => drawHorizontalPolyline(d, 20)).run({ count: 5 });
    for (const id of result.affected) {
      expect(result.document.entities[id]!.position[1]).toBeCloseTo(0, 6);
    }
  });
  it('open horizontal path + orient=true: instances have rotation [0,0,0] (tangent is +X)', () => {
    const result = scene().run({ count: 3, orient: true });
    for (const [rx, ry, rz] of rotations(result)) {
      expect(rx).toBeCloseTo(0, 6);
      expect(ry).toBeCloseTo(0, 6);
      expect(rz).toBeCloseTo(0, 6); // atan2(0, 1) = 0
    }
  });
  it('open vertical path + orient=true: instances have rotation[2] ≈ π/2', () => {
    const result = scene((d) => drawVerticalPolyline(d, 10)).run({ count: 3, orient: true });
    for (const rot of rotations(result)) {
      // Tangent is [0, 1] → atan2(1, 0) = π/2
      expect(rot[2]).toBeCloseTo(Math.PI / 2, 5);
    }
  });
  it('orient=false: all instances have rotation [0,0,0] regardless of path direction', () => {
    const result = scene((d) => drawVerticalPolyline(d, 10)).run({ count: 4, orient: false });
    for (const rot of rotations(result)) expect(rot).toEqual([0, 0, 0]);
  });
  it('count=1 on open path: single instance placed at startOffset=0 (path start)', () => {
    const result = scene((d) => drawHorizontalPolyline(d, 20)).run({ count: 1 });
    expect(result.affected).toHaveLength(1);
    const inst = result.document.entities[result.affected[0]!]!;
    expect(inst.position[0]).toBeCloseTo(0, 6);
    expect(inst.position[1]).toBeCloseTo(0, 6);
  });
  it('count=1 with startOffset=5 on open path: instance placed at x≈5', () => {
    const result = scene((d) => drawHorizontalPolyline(d, 20)).run({ count: 1, startOffset: 5 });
    expect(result.affected).toHaveLength(1);
    expect(result.document.entities[result.affected[0]!]!.position[0]).toBeCloseTo(5, 5);
  });
  it('startOffset and endOffset shrink the span: usable=[2,18] on length-20 path', () => {
    const result = scene((d) => drawHorizontalPolyline(d, 20)).run({ count: 3, startOffset: 2, endOffset: 2 });
    expect(result.affected).toHaveLength(3);
    const xPositions = result.affected.map((id) => result.document.entities[id]!.position[0]);
    expect(xPositions[0]!).toBeCloseTo(2, 5);
    expect(xPositions[2]!).toBeCloseTo(18, 5);
  });
  it('all created instance ids appear in doc.order', () => {
    const result = scene().run({ count: 4 });
    for (const id of result.affected) {
      expect(result.document.order).toContain(id);
    }
  });

  describe('closed belt path', () => {
    it('count=20: creates 20 instances around the loop', () => {
      const { componentId, run } = scene((d) => drawBeltLoop(d));
      const result = run({ count: 20 });
      expectInstances(result, componentId, 20);
    });
    it('count=20: instances cover the full loop (x-span covers both pulleys)', () => {
      const result = scene((d) => drawBeltLoop(d)).run({ count: 20 });
      // All 20 instances must be distinct (no two at the same position)
      const positions = result.affected.map((id) => result.document.entities[id]!.position);
      const uniqueXY = new Set(positions.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`));
      expect(uniqueXY.size).toBe(20);
      // Instances should span the belt: x range covers both pulleys (centers at x=0 and x=30)
      const xValues = positions.map((p) => p[0]);
      expect(Math.min(...xValues)).toBeLessThan(5); // near the left pulley (x=0, r=5)
      expect(Math.max(...xValues)).toBeGreaterThan(25); // near the right pulley (x=30, r=5)
    });
    it('count=20: instances are uniformly spread (no bunching, no gaps)', () => {
      // A belt has mixed straight + arc segments, so chord distances are NOT identical,
      // but uniform arc-length placement bounds them within a narrow band of the mean.
      // An off-by-one that bunched instances or left a gap would produce an outlier > 1.8x mean.
      const result = scene((d) => drawBeltLoop(d)).run({ count: 20 });
      const positions = result.affected.map((id) => result.document.entities[id]!.position);
      const chordDists: number[] = [];
      for (let i = 0; i < positions.length; i++) {
        const a = positions[i]!;
        const b = positions[(i + 1) % positions.length]!;
        chordDists.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
      }
      const mean = chordDists.reduce((s, d) => s + d, 0) / chordDists.length;
      for (const d of chordDists) {
        expect(d).toBeGreaterThan(0); // no coincident neighbors
        expect(d).toBeLessThan(mean * 1.8); // no off-by-one gap
      }
    });
    it('placement positions are deterministic from inputs (pure command)', () => {
      // Ids are time-tagged for global uniqueness but positions must depend only on params.
      const run = (): ReadonlyArray<readonly [number, number, number]> => {
        const r = scene((d) => drawBeltLoop(d)).run({ count: 5 });
        return r.affected.map((id) => r.document.entities[id]!.position);
      };
      const a = run();
      expect(a).toEqual(run());
      expect(a).toHaveLength(5);
    });
    it('count=1 on closed path: single instance created', () => {
      expect(scene((d) => drawBeltLoop(d)).run({ count: 1 }).affected).toHaveLength(1);
    });
    it('startOffset on closed path: shifts instance 0 forward along the loop', () => {
      const { run } = scene((d) => drawBeltLoop(d));
      const noOffset = run({ count: 1, startOffset: 0 });
      const withOffset = run({ count: 1, startOffset: 5 });
      const p0 = noOffset.document.entities[noOffset.affected[0]!]!.position;
      const p5 = withOffset.document.entities[withOffset.affected[0]!]!.position;
      const dist = Math.sqrt((p5[0] - p0[0]) ** 2 + (p5[1] - p0[1]) ** 2);
      expect(dist).toBeGreaterThan(0.01);
    });
  });
  it('L-shaped polyline: horizontal leg rz≈0, vertical leg rz≈π/2', () => {
    // L-shape: (0,0)→(10,0)→(10,10); total length = 20; count=3 → s=0, 10, 20
    const result = scene((d) => {
      const poly = execute(d, 'draw_polyline', { points: xy(0, 0, 10, 0, 10, 10), closed: false });
      return { doc: poly.document, pathId: poly.affected[0]! };
    }).run({ count: 3, orient: true });
    expect(result.affected).toHaveLength(3);
    const [r0, r1, r2] = rotations(result);
    expect(r0![2]).toBeCloseTo(0, 5);
    expect(r1![2]).toBeGreaterThanOrEqual(-1e-6); // at the vertex: between the legs' headings
    expect(r1![2]).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
    expect(r2![2]).toBeCloseTo(Math.PI / 2, 5);
  });
  it('summary names the component and the path length', () => {
    const { componentId, run } = scene();
    const result = run({ count: 5 });
    expect(result.summary).toContain('5');
    expect(result.summary).toContain(componentId);
    expect(result.summary).toContain('length');
  });
  // Failure paths — all must return unchanged doc reference + affected:[]
  const failures: Array<[string, Record<string, unknown>, string?]> = [
    ['pathId not found', { pathId: 'ghost-path', count: 3 }, 'ghost-path'],
    ['componentId not found', { componentId: 'ghost-comp', count: 3 }, 'ghost-comp'],
    ['both sourceId and componentId', { sourceId: 'a', count: 3 }, 'exactly one'],
    ['count < 1 (count=0)', { count: 0 }],
    ['count is non-integer (2.5)', { count: 2.5 }],
    ['count is NaN', { count: NaN }],
    ['startOffset is negative', { count: 3, startOffset: -1 }],
    ['endOffset is Infinity', { count: 3, endOffset: Infinity }],
    ['offsets exceed path length (usable <= 0)', { count: 3, startOffset: 6, endOffset: 6 }, 'offsets'],
  ];
  it.each(failures)('failure: %s', (_label, extra, summaryPart) => {
    const { doc, run } = scene();
    const result = run(extra);
    expectNoOp(result, doc);
    if (summaryPart) expect(result.summary).toContain(summaryPart);
  });
  it('failure: pathId is not a 2D curve (box)', () => {
    const { doc, componentId } = buildDocWithComponent();
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    expectNoOp(
      execute(box.document, 'pattern_along_path', { pathId: box.affected[0]!, componentId, count: 2 }),
      box.document,
      'not a 2D curve',
    );
  });
  it('failure: zero-length polyline (coincident points) → degenerate path', () => {
    const { doc, run } = scene((d) => {
      const poly = execute(d, 'draw_polyline', { points: xy(5, 5, 5, 5), closed: false });
      return { doc: poly.document, pathId: poly.affected[0]! };
    });
    expectNoOp(run({ count: 3 }), doc);
  });
  it('is pure (happy path): input document is not mutated', () => {
    const { doc, run } = scene();
    expectPure(doc, () => run({ count: 5 }));
  });
  it('is pure (failure path): input document is not mutated on error', () => {
    const { doc, componentId } = buildDocWithComponent();
    expectPure(doc, () => execute(doc, 'pattern_along_path', { pathId: 'ghost', componentId, count: 3 }));
  });
  it('toToolSchemas() length equals listCommands() length (1:1 invariant)', () => {
    expect(toToolSchemas()).toHaveLength(listCommands().length);
  });
});
