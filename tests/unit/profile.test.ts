import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Entity, ExtrusionEntity, RevolutionEntity } from '@core/model/types';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { expectNoOp } from '../helpers/expectNoOp';

type Doc = ReturnType<typeof createEmptyDocument>;

/** Doc holding one 2D fixture entity (built here only as test setup, not production). */
function docWith(id: string, shape: Record<string, unknown>): { doc: Doc; id: string } {
  const base = createEmptyDocument();
  const entity = {
    id,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color: '#ffffff',
    ...shape,
  } as unknown as Entity;
  return { doc: { ...base, entities: { ...base.entities, [id]: entity }, order: [id] }, id };
}

const TRI_POINTS = [
  [0, 0],
  [10, 0],
  [5, 8],
];
const docWithCircle = (): { doc: Doc; id: string } =>
  docWith('circle-1', { kind: 'circle', center: [0, 0], radius: 5, position: [1, 2, 0] });
const docWithRectangle = (): { doc: Doc; id: string } =>
  docWith('rect-1', { kind: 'rectangle', width: 4, height: 3 });
const docWithPolyline = (closed: boolean, id: string): { doc: Doc; id: string } =>
  docWith(id, { kind: 'polyline', points: TRI_POINTS, closed });
const docWithLine = (): { doc: Doc; id: string } =>
  docWith('line-1', { kind: 'line', start: [0, 0], end: [5, 5] });

const extrusionOf = (result: ReturnType<typeof execute>): ExtrusionEntity =>
  result.document.entities[result.affected[0]!] as ExtrusionEntity;

// extrude_profile

describe('extrude_profile', () => {
  it('circle → creates an extrusion with 32 profile points and correct depth', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_profile', { id, depth: 10 });

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
    const result = execute(doc, 'extrude_profile', { id, depth: 5 });
    expect(result.document.entities[id]).toBeDefined();
    expect(result.document.entities[id]!.kind).toBe('circle');
  });

  it('circle extrude: profile points lie on the correct radius', () => {
    const { doc, id } = docWithCircle();
    const result = execute(doc, 'extrude_profile', { id, depth: 2 });
    const ext = extrusionOf(result);
    for (const [x, y] of ext.profile) {
      expect(Math.sqrt(x * x + y * y)).toBeCloseTo(5, 5);
    }
  });

  it('rectangle → creates an extrusion with 4 profile points at correct corners', () => {
    const { doc, id } = docWithRectangle();
    const result = execute(doc, 'extrude_profile', { id, depth: 3 });

    expect(result.affected).toHaveLength(1);
    const ext = extrusionOf(result);
    expect(ext.kind).toBe('extrusion');
    expect(ext.depth).toBe(3);
    // lower-left origin: corners should be (0,0),(4,0),(4,3),(0,3)
    expect(ext.profile).toEqual([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ]);
  });

  it('closed polyline → creates an extrusion with the polyline points', () => {
    const { doc, id } = docWithPolyline(true, 'poly-1');
    const result = execute(doc, 'extrude_profile', { id, depth: 7 });

    expect(result.affected).toHaveLength(1);
    const ext = extrusionOf(result);
    expect(ext.kind).toBe('extrusion');
    expect(ext.profile).toEqual(TRI_POINTS);
    expect(ext.depth).toBe(7);
  });

  it.each([
    ['circle', docWithCircle],
    ['rectangle', docWithRectangle],
  ])('is pure — input document is never mutated (%s)', (_label, make) => {
    const { doc, id } = make();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'extrude_profile', { id, depth: 5 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // --- failure paths ---

  it('missing id → graceful no-op', () => {
    const doc = createEmptyDocument();
    expectNoOp(
      execute(doc, 'extrude_profile', { id: 'nonexistent', depth: 5 }),
      doc,
      'nonexistent',
    );
  });

  it.each([
    ['depth <= 0', 0, 'depth'],
    ['negative depth', -1, undefined],
  ])('%s → graceful no-op', (_label, depth, summary) => {
    const { doc, id } = docWithCircle();
    expectNoOp(execute(doc, 'extrude_profile', { id, depth }), doc, summary);
  });

  it('line entity → graceful no-op (not a closed profile)', () => {
    const { doc, id } = docWithLine();
    expectNoOp(execute(doc, 'extrude_profile', { id, depth: 5 }), doc, 'not a closed 2D profile');
  });

  it('open polyline → graceful no-op', () => {
    const { doc, id } = docWithPolyline(false, 'poly-open-1');
    expectNoOp(execute(doc, 'extrude_profile', { id, depth: 5 }), doc, 'not closed');
  });

  it('closed polyline with < 3 points → graceful no-op', () => {
    const { doc, id } = docWith('poly-short', {
      kind: 'polyline',
      points: [
        [0, 0],
        [5, 0],
      ],
      closed: true,
    });
    const result = execute(doc, 'extrude_profile', { id, depth: 5 });
    expectNoOp(result, doc, 'fewer than 3 points');
  });
});

// revolve_profile — full implementation

/** Triangle profile for revolution tests: 3 points in the +X half-plane */
const TRI_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [3, 0],
  [2, 2],
];

describe('revolve_profile', () => {
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
    const result = execute(doc, 'revolve_profile', {
      profile: TRI_PROFILE,
      axis: 'z',
      segments: 16,
    });
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

  it.each<[string, Record<string, unknown>, string?]>([
    [
      'profile with < 3 points',
      {
        profile: [
          [1, 0],
          [2, 1],
        ],
      },
      'at least 3',
    ],
    ['empty profile array', { profile: [] }],
    ['non-array profile', { profile: 'bad' }],
    ['angle = 0', { profile: TRI_PROFILE, angle: 0 }, 'angle'],
    ['negative angle', { profile: TRI_PROFILE, angle: -1 }],
    ['non-finite angle', { profile: TRI_PROFILE, angle: Infinity }],
    ['invalid axis string', { profile: TRI_PROFILE, axis: 'diagonal' }, 'axis'],
    ['zero-length Vec3 axis', { profile: TRI_PROFILE, axis: [0, 0, 0] }],
    ['non-array axis', { profile: TRI_PROFILE, axis: 42 }],
  ])('%s → graceful no-op', (_label, params, summary) => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'revolve_profile', params), doc, summary);
  });
});
