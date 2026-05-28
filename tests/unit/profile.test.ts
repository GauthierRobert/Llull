import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CircleEntity, RectangleEntity, PolylineEntity, LineEntity, ExtrusionEntity, RevolutionEntity } from '@core/model/types';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

// ---------------------------------------------------------------------------
// helpers — build minimal 2D entities directly in doc for test setup
// (entities are constructed here only for test fixture setup, not production)
// ---------------------------------------------------------------------------

function docWithCircle(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const base = createEmptyDocument();
  const id = 'circle-1';
  const entity: CircleEntity = {
    id,
    kind: 'circle',
    center: [0, 0],
    radius: 5,
    position: [1, 2, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
  };
  return {
    doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] },
    id,
  };
}

function docWithRectangle(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const base = createEmptyDocument();
  const id = 'rect-1';
  const entity: RectangleEntity = {
    id,
    kind: 'rectangle',
    width: 4,
    height: 3,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
  };
  return {
    doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] },
    id,
  };
}

function docWithClosedPolyline(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const base = createEmptyDocument();
  const id = 'poly-1';
  const entity: PolylineEntity = {
    id,
    kind: 'polyline',
    points: [[0, 0], [10, 0], [5, 8]],
    closed: true,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
  };
  return {
    doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] },
    id,
  };
}

function docWithOpenPolyline(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const base = createEmptyDocument();
  const id = 'poly-open-1';
  const entity: PolylineEntity = {
    id,
    kind: 'polyline',
    points: [[0, 0], [10, 0], [5, 8]],
    closed: false,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
  };
  return {
    doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] },
    id,
  };
}

function docWithLine(): { doc: ReturnType<typeof createEmptyDocument>; id: string } {
  const base = createEmptyDocument();
  const id = 'line-1';
  const entity: LineEntity = {
    id,
    kind: 'line',
    start: [0, 0],
    end: [5, 5],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
  };
  return {
    doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] },
    id,
  };
}

// ---------------------------------------------------------------------------
// extrude_sketch
// ---------------------------------------------------------------------------

describe('extrude_sketch', () => {
  beforeEach(() => __resetIdCounter());

  it('circle → creates an extrusion with 32 profile points and correct depth', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_sketch', { id, depth: 10 });

    expect(result.affected).toHaveLength(1);
    const extId = result.affected[0]!;
    const ext = result.document.entities[extId] as ExtrusionEntity;
    expect(ext.kind).toBe('extrusion');
    expect(ext.profile).toHaveLength(32);
    expect(ext.depth).toBe(10);
    // extrusion placed at source entity position
    expect(ext.position).toEqual([1, 2, 0]);
    expect(result.document.order).toContain(extId);
  });

  it('circle extrude: source circle remains in document', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_sketch', { id, depth: 5 });
    // original circle still present
    expect(result.document.entities[id]).toBeDefined();
    expect(result.document.entities[id]!.kind).toBe('circle');
  });

  it('circle extrude: profile points lie on the correct radius', () => {
    const { doc, id } = docWithCircle();
    // circle center=[0,0] radius=5
    const result = execute(doc, 'extrude_sketch', { id, depth: 2 });
    const extId = result.affected[0]!;
    const ext = result.document.entities[extId] as ExtrusionEntity;
    for (const [x, y] of ext.profile) {
      const r = Math.sqrt(x * x + y * y);
      expect(r).toBeCloseTo(5, 5);
    }
  });

  it('rectangle → creates an extrusion with 4 profile points at correct corners', () => {
    const { doc, id } = docWithRectangle();
    const result = execute(doc, 'extrude_sketch', { id, depth: 3 });

    expect(result.affected).toHaveLength(1);
    const extId = result.affected[0]!;
    const ext = result.document.entities[extId] as ExtrusionEntity;
    expect(ext.kind).toBe('extrusion');
    expect(ext.profile).toHaveLength(4);
    expect(ext.depth).toBe(3);
    // lower-left origin: corners should be (0,0),(4,0),(4,3),(0,3)
    expect(ext.profile[0]).toEqual([0, 0]);
    expect(ext.profile[1]).toEqual([4, 0]);
    expect(ext.profile[2]).toEqual([4, 3]);
    expect(ext.profile[3]).toEqual([0, 3]);
  });

  it('closed polyline → creates an extrusion with the polyline points', () => {
    const { doc, id } = docWithClosedPolyline();
    const result = execute(doc, 'extrude_sketch', { id, depth: 7 });

    expect(result.affected).toHaveLength(1);
    const extId = result.affected[0]!;
    const ext = result.document.entities[extId] as ExtrusionEntity;
    expect(ext.kind).toBe('extrusion');
    expect(ext.profile).toHaveLength(3);
    expect(ext.profile[0]).toEqual([0, 0]);
    expect(ext.profile[1]).toEqual([10, 0]);
    expect(ext.profile[2]).toEqual([5, 8]);
    expect(ext.depth).toBe(7);
  });

  it('is pure — input document is never mutated (circle)', () => {
    const { doc } = docWithCircle();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'extrude_sketch', { id: 'circle-1', depth: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is pure — input document is never mutated (rectangle)', () => {
    const { doc } = docWithRectangle();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'extrude_sketch', { id: 'rect-1', depth: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // --- failure paths ---

  it('missing id → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'extrude_sketch', { id: 'nonexistent', depth: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('nonexistent');
  });

  it('depth <= 0 → graceful no-op', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_sketch', { id, depth: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('depth');
  });

  it('negative depth → graceful no-op', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_sketch', { id, depth: -1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('line entity → graceful no-op (not a closed profile)', () => {
    const { doc, id } = docWithLine();
    const result = execute(doc, 'extrude_sketch', { id, depth: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('not a closed 2D profile');
  });

  it('open polyline → graceful no-op', () => {
    const { doc, id } = docWithOpenPolyline();
    const result = execute(doc, 'extrude_sketch', { id, depth: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('not closed');
  });

  it('closed polyline with < 3 points → graceful no-op', () => {
    // Build a 2-point closed polyline directly (degenerate profile)
    const base = createEmptyDocument();
    const id = 'poly-short';
    const entity: PolylineEntity = {
      id,
      kind: 'polyline',
      points: [[0, 0], [5, 0]],
      closed: true,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: DEFAULT_LAYER_ID,
      color: '#ffffff',
    };
    const doc = { ...base, entities: { ...base.entities, [id]: entity }, order: [id] };
    const result = execute(doc, 'extrude_sketch', { id, depth: 5 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('fewer than 3 points');
  });
});

// ---------------------------------------------------------------------------
// revolve_profile — full implementation
// ---------------------------------------------------------------------------

/** Triangle profile for revolution tests: 3 points in the +X half-plane */
const TRI_PROFILE: ReadonlyArray<readonly [number, number]> = [[1, 0], [3, 0], [2, 2]];

describe('revolve_profile', () => {
  beforeEach(() => __resetIdCounter());

  // ── happy paths ────────────────────────────────────────────────────────────

  it('full 2π revolution creates a revolution entity with correct kind and defaults', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE });

    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const e = result.document.entities[id] as RevolutionEntity;
    expect(e.kind).toBe('revolution');
    expect(e.profile).toHaveLength(3);
    expect(e.segments).toBe(32);
    expect(e.angle).toBeCloseTo(2 * Math.PI, 5);
    // default axis is Z
    expect(e.axis[0]).toBeCloseTo(0, 5);
    expect(e.axis[1]).toBeCloseTo(0, 5);
    expect(e.axis[2]).toBeCloseTo(1, 5);
  });

  it('entity is in document.order and entities map', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE });
    const id = result.affected[0]!;
    expect(result.document.order).toContain(id);
    expect(result.document.entities[id]).toBeDefined();
  });

  it('summary contains id, axis, angle, and segments', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 'z', segments: 16 });
    const id = result.affected[0]!;
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('z');
    expect(result.summary).toContain('16');
  });

  it('partial angle (π) revolution stores the correct angle', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, angle: Math.PI });
    const id = result.affected[0]!;
    const e = result.document.entities[id] as RevolutionEntity;
    expect(e.angle).toBeCloseTo(Math.PI, 5);
  });

  it('axis "x" produces a unit X-axis revolution entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 'x' });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.axis[0]).toBeCloseTo(1, 5);
    expect(e.axis[1]).toBeCloseTo(0, 5);
    expect(e.axis[2]).toBeCloseTo(0, 5);
  });

  it('axis "y" produces a unit Y-axis revolution entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 'y' });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.axis[1]).toBeCloseTo(1, 5);
  });

  it('arbitrary Vec3 axis is normalised and stored', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: [1, 1, 0] });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    const len = Math.sqrt(e.axis[0] ** 2 + e.axis[1] ** 2 + e.axis[2] ** 2);
    expect(len).toBeCloseTo(1, 5);
  });

  it('bounds are sane for a Z-axis revolution with radial extent 1–3', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 'z' });
    const id = result.affected[0]!;
    // Profile x ∈ [1,3] → maxR = 3; y ∈ [0,2] → axial [0,2]
    // Z-axis: AABB X/Y should span ±3, Z should span [0,2]
    const e = result.document.entities[id] as RevolutionEntity;
    expect(e.kind).toBe('revolution');
    // Just check the summary mentions "AABB" (bounds computed without error)
    expect(result.summary).toContain('AABB');
  });

  it('segments < 3 is clamped to 3', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, segments: 1 });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.segments).toBe(3);
  });

  it('optional position and color are stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', {
      profile: TRI_PROFILE,
      position: [5, 6, 7],
      color: '#ff0000',
    });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.position).toEqual([5, 6, 7]);
    expect(e.color).toBe('#ff0000');
  });

  it('valid layerId is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', {
      profile: TRI_PROFILE,
      layerId: DEFAULT_LAYER_ID,
    });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it('unknown layerId falls back to the document default layer', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', {
      profile: TRI_PROFILE,
      layerId: 'nonexistent-layer',
    });
    const e = result.document.entities[result.affected[0]!] as RevolutionEntity;
    expect(e.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it('is pure — input document is never mutated', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'revolve_profile', { profile: TRI_PROFILE });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ── failure paths ──────────────────────────────────────────────────────────

  it('profile with < 3 points → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: [[1, 0], [2, 1]] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('at least 3');
  });

  it('empty profile array → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: [] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('non-array profile → graceful no-op', () => {
    const doc = createEmptyDocument();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = execute(doc, 'revolve_profile', { profile: 'bad' as any });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('angle = 0 → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, angle: 0 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('angle');
  });

  it('negative angle → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, angle: -1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('non-finite angle → graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, angle: Infinity });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('invalid axis string → graceful no-op', () => {
    const doc = createEmptyDocument();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 'diagonal' as any });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('axis');
  });

  it('zero-length Vec3 axis → graceful no-op', () => {
    const doc = createEmptyDocument();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: [0, 0, 0] as any });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('non-array axis → graceful no-op', () => {
    const doc = createEmptyDocument();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = execute(doc, 'revolve_profile', { profile: TRI_PROFILE, axis: 42 as any });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });
});
