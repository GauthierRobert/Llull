import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CircleEntity, RectangleEntity, PolylineEntity, LineEntity, ExtrusionEntity } from '@core/model/types';
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
});

// ---------------------------------------------------------------------------
// revolve_profile (stub)
// ---------------------------------------------------------------------------

describe('revolve_profile', () => {
  beforeEach(() => __resetIdCounter());

  it('is a registered no-op stub — returns unchanged document', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'revolve_profile', { id });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('stub summary mentions "not yet implemented" and the entity id', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'revolve_profile', { id });
    expect(result.summary).toContain('not yet implemented');
    expect(result.summary).toContain(id);
  });

  it('is pure — input document is never mutated', () => {
    const { doc, id } = docWithCircle();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'revolve_profile', { id });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('accepts optional angle param without throwing', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'revolve_profile', { id, angle: Math.PI });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });
});
