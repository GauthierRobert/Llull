import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { PolylineEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sampleInvolute } from '@core/commands/gears';
import { __resetIdCounter } from '@lib/id';

describe('draw_involute', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // Happy path — basic shape
  // ---------------------------------------------------------------------------

  it('creates exactly one open polyline entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: 4, endAngle: Math.PI });
    expect(result.affected).toHaveLength(1);
    expect(result.document.order).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('polyline');
    expect((entity as PolylineEntity).closed).toBe(false);
  });

  it('defaults samples=24 — polyline has 24 points', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: 4, endAngle: Math.PI });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    expect(poly.points).toHaveLength(24);
  });

  it('first point is approximately (baseRadius, 0) when startAngle=0', () => {
    const baseRadius = 4;
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius, endAngle: Math.PI });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    const [x0, y0] = poly.points[0]!;
    expect(x0).toBeCloseTo(baseRadius, 9);
    expect(y0).toBeCloseTo(0, 9);
  });

  it('last point radius from origin equals baseR * sqrt(1 + tEnd²) within 1e-9', () => {
    const baseRadius = 4;
    const endAngle = Math.PI;
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius, endAngle });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    const last = poly.points[poly.points.length - 1]!;
    const actualR = Math.sqrt(last[0] ** 2 + last[1] ** 2);
    const expectedR = baseRadius * Math.sqrt(1 + endAngle ** 2);
    expect(Math.abs(actualR - expectedR)).toBeLessThan(1e-9);
  });

  // ---------------------------------------------------------------------------
  // Math cross-check with PG1 (shared helper proves one source of truth)
  // ---------------------------------------------------------------------------

  it('endpoint radius matches gear outerRadius — proves shared sampleInvolute helper', () => {
    // Derive the gear parameters used in addSpurGear tests:
    //   module=2, teeth=42, pressureAngle=Math.PI/9
    const mod = 2;
    const teeth = 42;
    const pressureAngle = Math.PI / 9;
    const pitchRadius = (mod * teeth) / 2;          // 42
    const baseR = pitchRadius * Math.cos(pressureAngle);
    const outerRadius = pitchRadius + mod;           // 44

    // The involute's tMax parameter where it reaches outerRadius:
    //   baseR * sqrt(1 + tMax²) = outerRadius  →  tMax = sqrt((outerRadius/baseR)² − 1)
    const tMax = Math.sqrt((outerRadius / baseR) ** 2 - 1);

    // Sample the same curve PG1 uses internally.
    const pts = sampleInvolute(baseR, 0, tMax, 14);
    const last = pts[pts.length - 1]!;
    const actualR = Math.sqrt(last[0] ** 2 + last[1] ** 2);

    expect(Math.abs(actualR - outerRadius)).toBeLessThan(1e-9);
  });

  // ---------------------------------------------------------------------------
  // samples param
  // ---------------------------------------------------------------------------

  it('explicit samples=10 produces 10 points', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 3,
      endAngle: 2,
      samples: 10,
    });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    expect(poly.points).toHaveLength(10);
  });

  it('samples=2 produces exactly 2 points (minimum)', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 5,
      endAngle: 1,
      samples: 2,
    });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    expect(poly.points).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // startAngle default
  // ---------------------------------------------------------------------------

  it('omitting startAngle defaults to 0 — same as explicit startAngle=0', () => {
    const doc = createEmptyDocument();
    __resetIdCounter();
    const r1 = execute(doc, 'draw_involute', { baseRadius: 4, endAngle: 2 });
    __resetIdCounter();
    const r2 = execute(doc, 'draw_involute', { baseRadius: 4, startAngle: 0, endAngle: 2 });
    const p1 = (r1.document.entities[r1.affected[0]!] as PolylineEntity).points;
    const p2 = (r2.document.entities[r2.affected[0]!] as PolylineEntity).points;
    expect(p1.length).toBe(p2.length);
    for (let i = 0; i < p1.length; i++) {
      expect(p1[i]![0]).toBeCloseTo(p2[i]![0], 12);
      expect(p1[i]![1]).toBeCloseTo(p2[i]![1], 12);
    }
  });

  // ---------------------------------------------------------------------------
  // position / rotation placement
  // ---------------------------------------------------------------------------

  it('position is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 3,
      endAngle: 1,
      position: [5, -2, 7],
    });
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.position).toEqual([5, -2, 7]);
  });

  it('rotation is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 3,
      endAngle: 1,
      rotation: [0, 0, Math.PI],
    });
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.rotation[2]).toBeCloseTo(Math.PI, 9);
  });

  it('different positions produce distinct entity placements', () => {
    const doc = createEmptyDocument();
    __resetIdCounter();
    const r1 = execute(doc, 'draw_involute', { baseRadius: 3, endAngle: 1, position: [0, 0, 0] });
    __resetIdCounter();
    const r2 = execute(doc, 'draw_involute', { baseRadius: 3, endAngle: 1, position: [10, 0, 0] });
    expect(r2.document.entities[r2.affected[0]!]!.position[0]).toBe(10);
    expect(r1.document.entities[r1.affected[0]!]!.position[0]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  it('summary contains entity id, baseRadius, sweep range, and sample count', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 4,
      startAngle: 0.5,
      endAngle: 2.5,
      samples: 12,
    });
    const id = result.affected[0]!;
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('4');       // baseRadius
    expect(result.summary).toContain('0.5');     // startAngle
    expect(result.summary).toContain('2.5');     // endAngle
    expect(result.summary).toContain('12');      // samples
  });

  // ---------------------------------------------------------------------------
  // Failure paths
  // ---------------------------------------------------------------------------

  it('baseRadius=0 -> no-op, affected:[], summary mentions baseRadius', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: 0, endAngle: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/baseRadius/i);
  });

  it('baseRadius<0 -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: -3, endAngle: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('samples=1 -> no-op, affected:[], summary mentions samples', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: 4, endAngle: 1, samples: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/samples/i);
  });

  it('endAngle <= startAngle -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 4,
      startAngle: 2,
      endAngle: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/endAngle/i);
  });

  it('endAngle === startAngle -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 4,
      startAngle: 1,
      endAngle: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN baseRadius -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: NaN, endAngle: 1 });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('Infinity endAngle -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', { baseRadius: 4, endAngle: Infinity });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN startAngle -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 4,
      startAngle: NaN,
      endAngle: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN samples -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_involute', {
      baseRadius: 4,
      endAngle: 1,
      samples: NaN,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  // ---------------------------------------------------------------------------
  // Purity
  // ---------------------------------------------------------------------------

  it('is pure — happy path does not mutate input doc', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'draw_involute', { baseRadius: 4, endAngle: Math.PI });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is pure — failure path does not mutate input doc', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'draw_involute', { baseRadius: -1, endAngle: 1 });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});
