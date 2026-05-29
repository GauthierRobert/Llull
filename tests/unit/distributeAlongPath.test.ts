/**
 * Tests for distribute_along_path command.
 *
 * Setup pattern: draw a path (polyline or belt), create a tiny component from a box,
 * then call distribute_along_path and assert the resulting instances.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { InstanceEntity, PolylineEntity } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

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
function drawBeltLoop(
  doc: ReturnType<typeof createEmptyDocument>,
): { doc: ReturnType<typeof createEmptyDocument>; pathId: string; totalLength: number } {
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

describe('distribute_along_path', () => {
  beforeEach(() => __resetIdCounter());

  // -------------------------------------------------------------------------
  // Happy paths — open path
  // -------------------------------------------------------------------------

  it('open horizontal path, count=5: creates 5 instances at evenly-spaced x positions', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 40);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 5 });

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
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 20);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 5 });

    for (const id of result.affected) {
      expect(result.document.entities[id]!.position[1]).toBeCloseTo(0, 6);
    }
  });

  it('open horizontal path + tangentAlign=true: instances have rotation [0,0,0] (tangent is +X)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      tangentAlign: true,
    });

    for (const id of result.affected) {
      const inst = result.document.entities[id] as InstanceEntity;
      expect(inst.rotation[0]).toBeCloseTo(0, 6);
      expect(inst.rotation[1]).toBeCloseTo(0, 6);
      expect(inst.rotation[2]).toBeCloseTo(0, 6); // atan2(0, 1) = 0
    }
  });

  it('open vertical path + tangentAlign=true: instances have rotation[2] ≈ π/2', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawVerticalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      tangentAlign: true,
    });

    for (const id of result.affected) {
      const inst = result.document.entities[id] as InstanceEntity;
      // Tangent is [0, 1] → atan2(1, 0) = π/2
      expect(inst.rotation[2]).toBeCloseTo(Math.PI / 2, 5);
    }
  });

  it('tangentAlign=false: all instances have rotation [0,0,0] regardless of path direction', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawVerticalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 4,
      tangentAlign: false,
    });

    for (const id of result.affected) {
      const inst = result.document.entities[id] as InstanceEntity;
      expect(inst.rotation).toEqual([0, 0, 0]);
    }
  });

  it('count=1 on open path: single instance placed at startOffset=0 (path start)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 20);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 1 });

    expect(result.affected).toHaveLength(1);
    const inst = result.document.entities[result.affected[0]!]!;
    expect(inst.position[0]).toBeCloseTo(0, 6);
    expect(inst.position[1]).toBeCloseTo(0, 6);
  });

  it('count=1 with startOffset=5 on open path: instance placed at x≈5', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 20);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 1,
      startOffset: 5,
    });

    expect(result.affected).toHaveLength(1);
    const inst = result.document.entities[result.affected[0]!]!;
    expect(inst.position[0]).toBeCloseTo(5, 5);
  });

  it('startOffset and endOffset shrink the span: usable=[2,18] on length-20 path', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 20);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
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
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      name: 'bolt',
    });

    const names = result.affected.map(
      (id) => (result.document.entities[id] as InstanceEntity & { name?: string }).name,
    );
    expect(names[0]).toBe('bolt_0');
    expect(names[1]).toBe('bolt_1');
    expect(names[2]).toBe('bolt_2');
  });

  it('all created instance ids appear in doc.order', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 4 });

    for (const id of result.affected) {
      expect(result.document.order).toContain(id);
    }
  });

  // -------------------------------------------------------------------------
  // Happy paths — closed path (belt loop)
  // -------------------------------------------------------------------------

  it('closed belt path, count=20: creates 20 instances around the loop', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const beltResult = drawBeltLoop(doc);
    doc = beltResult.doc;
    const pathId = beltResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 20 });

    expect(result.affected).toHaveLength(20);
    for (const id of result.affected) {
      const inst = result.document.entities[id] as InstanceEntity;
      expect(inst.kind).toBe('instance');
      expect(inst.componentId).toBe(componentId);
    }
  });

  it('closed belt path, count=20: instances cover the full loop (x-span covers both pulleys)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const beltResult = drawBeltLoop(doc);
    doc = beltResult.doc;
    const pathId = beltResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 20 });

    // All 20 instances must be distinct (no two at the same position)
    const positions = result.affected.map((id) => result.document.entities[id]!.position);
    const uniqueXY = new Set(positions.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`));
    expect(uniqueXY.size).toBe(20);

    // Instances should span the belt: x range covers both pulleys (centers at x=0 and x=30)
    const xValues = positions.map((p) => p[0]);
    const minX = Math.min(...xValues);
    const maxX = Math.max(...xValues);
    expect(minX).toBeLessThan(5);   // instances near the left pulley (x=0, r=5)
    expect(maxX).toBeGreaterThan(25); // instances near the right pulley (x=30, r=5)
  });

  it('closed belt path, count=20: instances are uniformly spread (no bunching, no gaps)', () => {
    // Pins closed-path placement uniformity. A belt has mixed straight + arc segments,
    // so direct chord distances are NOT identical (the chord-vs-arc bias differs by
    // segment kind), but a uniform arc-length placement still bounds the chord
    // distances within a narrow band of the mean. A future off-by-one that bunched
    // instances or left a gap would produce an outlier > 1.8× the mean.
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const beltResult = drawBeltLoop(doc);
    doc = beltResult.doc;
    const pathId = beltResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 20 });

    const positions = result.affected.map((id) => result.document.entities[id]!.position);
    const chordDists: number[] = [];
    for (let i = 0; i < positions.length; i++) {
      const a = positions[i]!;
      const b = positions[(i + 1) % positions.length]!;
      chordDists.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const sum = chordDists.reduce((s, d) => s + d, 0);
    const mean = sum / chordDists.length;
    for (const d of chordDists) {
      expect(d).toBeGreaterThan(0); // no coincident neighbors
      expect(d).toBeLessThan(mean * 1.8); // no off-by-one gap
    }
  });

  it('closed belt path: placement positions are deterministic from inputs (pure command)', () => {
    // Pins the determinism contract called out in the assemblies.ts follow-up note:
    // expandInstance was minting fresh ids per memo recompute. distribute_along_path
    // must NOT introduce a similar non-deterministic POSITION source — ids are time-
    // tagged for global uniqueness but positions must depend only on params.
    const run = (): ReadonlyArray<readonly [number, number, number]> => {
      __resetIdCounter();
      const init = buildDocWithComponent();
      let doc = init.doc;
      const beltResult = drawBeltLoop(doc);
      doc = beltResult.doc;
      const r = execute(doc, 'distribute_along_path', {
        pathId: beltResult.pathId,
        componentId: init.componentId,
        count: 5,
      });
      return r.affected.map((id) => r.document.entities[id]!.position);
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });

  it('count=1 on closed path: single instance created', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const beltResult = drawBeltLoop(doc);
    doc = beltResult.doc;
    const pathId = beltResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 1 });

    expect(result.affected).toHaveLength(1);
  });

  it('startOffset on closed path: shifts instance 0 forward along the loop', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const beltResult = drawBeltLoop(doc);
    doc = beltResult.doc;
    const pathId = beltResult.pathId;

    const noOffset = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 1,
      startOffset: 0,
    });
    const withOffset = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 1,
      startOffset: 5,
    });

    const p0 = noOffset.document.entities[noOffset.affected[0]!]!.position;
    const p5 = withOffset.document.entities[withOffset.affected[0]!]!.position;

    const dist = Math.sqrt((p5[0] - p0[0]) ** 2 + (p5[1] - p0[1]) ** 2);
    expect(dist).toBeGreaterThan(0.01);
  });

  // -------------------------------------------------------------------------
  // L-shaped polyline — tangent changes between segments
  // -------------------------------------------------------------------------

  it('L-shaped polyline: horizontal leg rz≈0, vertex+vertical leg rz≈π/2', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;

    // L-shape: (0,0)→(10,0)→(10,10); total length = 20
    const polyResult = execute(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      closed: false,
    });
    doc = polyResult.document;
    const pathId = polyResult.affected[0]!;

    // count=3, no offsets → placements at s=0, s=10, s=20
    // s=0: horizontal segment → rz=0
    // s=10: at the vertex; outgoing segment is vertical → rz=π/2
    // s=20: end of vertical segment → rz=π/2
    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      tangentAlign: true,
    });

    expect(result.affected).toHaveLength(3);

    const inst0 = result.document.entities[result.affected[0]!] as InstanceEntity;
    const inst1 = result.document.entities[result.affected[1]!] as InstanceEntity;
    const inst2 = result.document.entities[result.affected[2]!] as InstanceEntity;

    expect(inst0.rotation[2]).toBeCloseTo(0, 5);
    expect(inst1.rotation[2]).toBeCloseTo(Math.PI / 2, 3);
    expect(inst2.rotation[2]).toBeCloseTo(Math.PI / 2, 5);
  });

  // -------------------------------------------------------------------------
  // Summary content
  // -------------------------------------------------------------------------

  it('summary contains component name, path id, length=, spacing=', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 5 });

    expect(result.summary).toContain('5');
    expect(result.summary).toContain(pathId);
    expect(result.summary).toContain('length=');
    expect(result.summary).toContain('spacing=');
  });

  // -------------------------------------------------------------------------
  // Failure paths — all must return unchanged doc reference + affected:[]
  // -------------------------------------------------------------------------

  it('failure: pathId not found', () => {
    const { doc, componentId } = buildDocWithComponent();
    const result = execute(doc, 'distribute_along_path', {
      pathId: 'ghost-path',
      componentId,
      count: 3,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost-path');
  });

  it('failure: pathId is wrong kind (box, not polyline/spline)', () => {
    let doc = createEmptyDocument();
    const box1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = box1.document;
    const boxId = box1.affected[0]!;

    const box2 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = box2.document;
    const boxId2 = box2.affected[0]!;

    const compResult = execute(doc, 'create_component', { name: 'c', entityIds: [boxId2] });
    doc = compResult.document;
    const componentId = Object.keys(doc.components)[0]!;

    const result = execute(doc, 'distribute_along_path', {
      pathId: boxId,
      componentId,
      count: 2,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('"box"');
  });

  it('failure: zero-length polyline (coincident points) → degenerate path', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;

    const polyResult = execute(doc, 'draw_polyline', {
      points: [
        [5, 5],
        [5, 5],
      ],
      closed: false,
    });
    doc = polyResult.document;
    const pathId = polyResult.affected[0]!;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 3 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: componentId not found', () => {
    let doc = buildDocWithComponent().doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId: 'ghost-comp',
      count: 3,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost-comp');
  });

  it('failure: count < 1 (count=0)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: count is non-integer (2.5)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: 2.5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: count is NaN', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', { pathId, componentId, count: NaN });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: startOffset is negative', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      startOffset: -1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: endOffset is Infinity', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      endOffset: Infinity,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('failure: offsets exceed path length (usable <= 0)', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const result = execute(doc, 'distribute_along_path', {
      pathId,
      componentId,
      count: 3,
      startOffset: 6,
      endOffset: 6, // 6 + 6 = 12 > 10
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('usable');
  });

  // -------------------------------------------------------------------------
  // Purity — input doc must never be mutated
  // -------------------------------------------------------------------------

  it('is pure (happy path): input document is not mutated', () => {
    const init = buildDocWithComponent();
    const componentId = init.componentId;
    let doc = init.doc;
    const pathResult = drawHorizontalPolyline(doc, 10);
    doc = pathResult.doc;
    const pathId = pathResult.pathId;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'distribute_along_path', { pathId, componentId, count: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is pure (failure path): input document is not mutated on error', () => {
    const { doc, componentId } = buildDocWithComponent();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'distribute_along_path', { pathId: 'ghost', componentId, count: 3 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // -------------------------------------------------------------------------
  // Registry invariant
  // -------------------------------------------------------------------------

  it('toToolSchemas() length equals listCommands() length (1:1 invariant)', () => {
    expect(toToolSchemas()).toHaveLength(listCommands().length);
  });

  it('distribute_along_path is registered in listCommands()', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('distribute_along_path');
  });
});
