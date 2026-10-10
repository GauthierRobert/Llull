/**
 * Tests for distribute_along_path command.
 *
 * Setup pattern: draw a path (polyline or belt), create a tiny component from a box,
 * then call distribute_along_path and assert the resulting instances.
 */
import { describe, it, expect } from 'vitest';
import { type InstanceEntity, type PolylineEntity, createEmptyDocument } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Draw a horizontal open polyline from (0,0) to (length, 0) in local space,
 * placed at world origin.
 */
function drawHorizontalPolyline(
  doc: ReturnType<typeof createEmptyDocument>,
  length: number,
): { doc: ReturnType<typeof createEmptyDocument>; pathId: string } {
  const result = execute(doc, 'draw_polyline', {
    points: [
      [0, 0],
      [length, 0],
    ],
    closed: false,
  });
  return { doc: result.document, pathId: result.affected[0]! };
}

/**
 * Draw a vertical open polyline from (0,0) to (0, length).
 */
function drawVerticalPolyline(
  doc: ReturnType<typeof createEmptyDocument>,
  length: number,
): { doc: ReturnType<typeof createEmptyDocument>; pathId: string } {
  const result = execute(doc, 'draw_polyline', {
    points: [
      [0, 0],
      [0, length],
    ],
    closed: false,
  });
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

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
  return {
    doc,
    componentId,
    pathId,
    run: (extra) => execute(doc, 'distribute_along_path', { pathId, componentId, ...extra }),
  };
}

const rotations = (r: ReturnType<typeof execute>): number[][] =>
  r.affected.map((id) => [...(r.document.entities[id] as InstanceEntity).rotation]);

describe('distribute_along_path', () => {
  it('open horizontal path, count=5: creates 5 instances at evenly-spaced x positions', () => {
    const { componentId, run } = scene((d) => drawHorizontalPolyline(d, 40));
    const result = run({ count: 5 });

    expect(result.affected).toHaveLength(5);
    expect(result.affected.every((id) => id in result.document.entities)).toBe(true);

    for (const id of result.affected) {
      const inst = result.document.entities[id] as InstanceEntity;
      expect(inst.kind).toBe('instance');
      expect(inst.componentId).toBe(componentId);
    }

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

  it('open horizontal path + tangentAlign=true: instances have rotation [0,0,0] (tangent is +X)', () => {
    const result = scene().run({ count: 3, tangentAlign: true });
    for (const [rx, ry, rz] of rotations(result)) {
      expect(rx).toBeCloseTo(0, 6);
      expect(ry).toBeCloseTo(0, 6);
      expect(rz).toBeCloseTo(0, 6); // atan2(0, 1) = 0
    }
  });

  it('open vertical path + tangentAlign=true: instances have rotation[2] ≈ π/2', () => {
    const result = scene((d) => drawVerticalPolyline(d, 10)).run({ count: 3, tangentAlign: true });
    for (const rot of rotations(result)) {
      // Tangent is [0, 1] → atan2(1, 0) = π/2
      expect(rot[2]).toBeCloseTo(Math.PI / 2, 5);
    }
  });

  it('tangentAlign=false: all instances have rotation [0,0,0] regardless of path direction', () => {
    const result = scene((d) => drawVerticalPolyline(d, 10)).run({
      count: 4,
      tangentAlign: false,
    });
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
    const result = scene((d) => drawHorizontalPolyline(d, 20)).run({
      count: 3,
      startOffset: 2,
      endOffset: 2,
    });
    expect(result.affected).toHaveLength(3);
    const xPositions = result.affected.map((id) => result.document.entities[id]!.position[0]);
    expect(xPositions[0]!).toBeCloseTo(2, 5);
    expect(xPositions[2]!).toBeCloseTo(18, 5);
  });

  it('name prefix: instances are named <prefix>_0, <prefix>_1, ...', () => {
    const result = scene().run({ count: 3, name: 'bolt' });
    const names = result.affected.map(
      (id) => (result.document.entities[id] as InstanceEntity & { name?: string }).name,
    );
    expect(names).toEqual(['bolt_0', 'bolt_1', 'bolt_2']);
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
      expect(result.affected).toHaveLength(20);
      for (const id of result.affected) {
        const inst = result.document.entities[id] as InstanceEntity;
        expect(inst.kind).toBe('instance');
        expect(inst.componentId).toBe(componentId);
      }
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

  it('L-shaped polyline: horizontal leg rz≈0, vertex+vertical leg rz≈π/2', () => {
    // L-shape: (0,0)→(10,0)→(10,10); total length = 20; count=3 → s=0, 10, 20
    const result = scene((d) => {
      const poly = execute(d, 'draw_polyline', {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        closed: false,
      });
      return { doc: poly.document, pathId: poly.affected[0]! };
    }).run({ count: 3, tangentAlign: true });

    expect(result.affected).toHaveLength(3);
    const [r0, r1, r2] = rotations(result);
    expect(r0![2]).toBeCloseTo(0, 5);
    expect(r1![2]).toBeCloseTo(Math.PI / 2, 3); // at the vertex the outgoing leg is vertical
    expect(r2![2]).toBeCloseTo(Math.PI / 2, 5);
  });

  it('summary contains component name, path id, length=, spacing=', () => {
    const { pathId, run } = scene();
    const result = run({ count: 5 });
    expect(result.summary).toContain('5');
    expect(result.summary).toContain(pathId);
    expect(result.summary).toContain('length=');
    expect(result.summary).toContain('spacing=');
  });

  // Failure paths — all must return unchanged doc reference + affected:[]
  const failures: Array<[string, Record<string, unknown>, string?]> = [
    ['pathId not found', { pathId: 'ghost-path', count: 3 }, 'ghost-path'],
    ['componentId not found', { componentId: 'ghost-comp', count: 3 }, 'ghost-comp'],
    ['count < 1 (count=0)', { count: 0 }],
    ['count is non-integer (2.5)', { count: 2.5 }],
    ['count is NaN', { count: NaN }],
    ['startOffset is negative', { count: 3, startOffset: -1 }],
    ['endOffset is Infinity', { count: 3, endOffset: Infinity }],
    [
      'offsets exceed path length (usable <= 0)',
      { count: 3, startOffset: 6, endOffset: 6 },
      'usable',
    ],
  ];
  it.each(failures)('failure: %s', (_label, extra, summaryPart) => {
    const { doc, run } = scene();
    const result = run(extra);
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    if (summaryPart) expect(result.summary).toContain(summaryPart);
  });

  it('failure: pathId is wrong kind (box, not polyline/spline)', () => {
    const { doc, componentId } = buildDocWithComponent();
    const box = execute(doc, 'add_box', { size: [1, 1, 1] });
    const result = execute(box.document, 'distribute_along_path', {
      pathId: box.affected[0]!,
      componentId,
      count: 2,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(box.document);
    expect(result.summary).toContain('"box"');
  });

  it('failure: zero-length polyline (coincident points) → degenerate path', () => {
    const { doc, run } = scene((d) => {
      const poly = execute(d, 'draw_polyline', {
        points: [
          [5, 5],
          [5, 5],
        ],
        closed: false,
      });
      return { doc: poly.document, pathId: poly.affected[0]! };
    });
    const result = run({ count: 3 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('is pure (happy path): input document is not mutated', () => {
    const { doc, run } = scene();
    const snapshot = JSON.stringify(doc);
    run({ count: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is pure (failure path): input document is not mutated on error', () => {
    const { doc, componentId } = buildDocWithComponent();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'distribute_along_path', { pathId: 'ghost', componentId, count: 3 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('toToolSchemas() length equals listCommands() length (1:1 invariant)', () => {
    expect(toToolSchemas()).toHaveLength(listCommands().length);
  });

  it('distribute_along_path is registered in listCommands()', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('distribute_along_path');
  });
});
