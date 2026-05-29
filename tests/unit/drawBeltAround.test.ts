import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { PolylineEntity } from '@core/model/types';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

describe('draw_belt_around', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // Happy path — 2-pulley equal-radius
  // ---------------------------------------------------------------------------

  it('2 equal-radius pulleys: creates one closed polyline entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    const entity = result.document.entities[id]!;
    expect(entity.kind).toBe('polyline');
    expect((entity as PolylineEntity).closed).toBe(true);
  });

  it('2 equal-radius pulleys: tangent lines are horizontal at y=±5', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      arcSamples: 2,
    });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    const pts = poly.points;

    // With arcSamples=2, each pulley arc produces 2 sampled points.
    // The loop structure (2 pulleys, 2 arcs × 2 samples each + 2 tangent start points):
    // total points = 2 tangent-start points + 2 arcs × 2 = 6 points.
    // The two tangent start points (outgoing TPs on each pulley) sit at y ≈ ±5.
    const yValues = pts.map(([, y]) => y);
    const topTangent = yValues.some((y) => Math.abs(y - 5) < 1e-9);
    const botTangent = yValues.some((y) => Math.abs(y + 5) < 1e-9);
    expect(topTangent).toBe(true);
    expect(botTangent).toBe(true);
  });

  it('2 equal-radius pulleys: each pulley contributes a 180° wrap arc', () => {
    // For equal-radius pulleys on the same horizontal line, the external tangent
    // angle α = asin(0) = 0, so the tangent points are at θ±π/2 = ±90° from
    // the center line.  Each pulley's wrap arc sweeps exactly π radians.
    const doc = createEmptyDocument();
    const r = 5;
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: r },
        { center: [20, 0], radius: r },
      ],
      arcSamples: 36,
    });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;

    // Total polyline points: 2 tangent-start pts + 2 arcs × 36 points each = 74
    expect(poly.points).toHaveLength(74);
  });

  // ---------------------------------------------------------------------------
  // Happy path — 2-pulley different-radius
  // ---------------------------------------------------------------------------

  it('2 different-radius pulleys: first polyline point is the outgoing TP on pulley 0', () => {
    const r1 = 5;
    const r2 = 3;
    const cx1 = 0, cy1 = 0;
    const cx2 = 20, cy2 = 0;
    const d = 20;
    const alpha = Math.asin((r1 - r2) / d);
    const theta = 0; // atan2(0, 20) = 0
    const expectedAngle = theta + Math.PI / 2 + alpha;

    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [cx1, cy1], radius: r1 },
        { center: [cx2, cy2], radius: r2 },
      ],
      arcSamples: 2,
    });
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    const pts = poly.points;

    // The first point in the loop is the outgoing TP on pulley 0.
    // It should be at (cx1 + r1*cos(expectedAngle), cy1 + r1*sin(expectedAngle)).
    const tp1 = pts[0]!;
    expect(tp1[0]).toBeCloseTo(cx1 + r1 * Math.cos(expectedAngle), 9);
    expect(tp1[1]).toBeCloseTo(cy1 + r1 * Math.sin(expectedAngle), 9);

    // All arc points on pulley 1 lie exactly at radius r2 from its center cx2,cy2.
    // arcSamples=2 means 2 arc pts per pulley; pts indices for pulley-1 arc are 1 and 2.
    for (const pt of [pts[1]!, pts[2]!]) {
      const distFromC2 = Math.sqrt((pt[0] - cx2) ** 2 + (pt[1] - cy2) ** 2);
      expect(distFromC2).toBeCloseTo(r2, 9);
    }
  });

  it('2 different-radius pulleys: summary reports a positive length', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 3 },
      ],
      arcSamples: 2,
    });
    expect(result.summary).toContain('belt');
    expect(result.summary).toMatch(/length ≈ \d/);
  });

  // ---------------------------------------------------------------------------
  // Happy path — 3-pulley equilateral triangle
  // ---------------------------------------------------------------------------

  it('3-pulley equilateral: creates closed polyline with 3 tangent segs + 3 arcs', () => {
    const r = 3;
    const side = 30;
    // Equilateral triangle vertices
    const pulleys = [
      { center: [0, 0] as [number, number], radius: r },
      { center: [side, 0] as [number, number], radius: r },
      { center: [side / 2, (side * Math.sqrt(3)) / 2] as [number, number], radius: r },
    ];
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', { pulleys, arcSamples: 12 });
    expect(result.affected).toHaveLength(1);
    const id = result.affected[0]!;
    const poly = result.document.entities[id] as PolylineEntity;
    // 3 pulleys, each contributing 1 tangent-start point + 12 arc samples = 3*(1+12) = 39 pts
    expect(poly.points).toHaveLength(39);
    expect(poly.closed).toBe(true);
  });

  it('3-pulley equilateral: total length ≈ 3 * tangentLen + full circumference of one pulley', () => {
    const r = 3;
    const side = 30;
    const pulleys = [
      { center: [0, 0] as [number, number], radius: r },
      { center: [side, 0] as [number, number], radius: r },
      { center: [side / 2, (side * Math.sqrt(3)) / 2] as [number, number], radius: r },
    ];
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', { pulleys });
    // For equal-radius pulleys in equilateral arrangement, each pair has
    // α=0, so tangent length ≈ distance between centers = side (for r1=r2).
    // Actually tangent length = sqrt(d² - (r1-r2)²) = sqrt(d²) = d when r1=r2.
    // Total wrap = 3 arcs of 120° each = 360° = 2π*r (one full circumference).
    const expectedLength = 3 * side + 2 * Math.PI * r;
    // Parse length from summary
    const match = result.summary.match(/length ≈ ([\d.]+)/);
    expect(match).not.toBeNull();
    const reportedLength = parseFloat(match![1]!);
    expect(Math.abs(reportedLength - expectedLength)).toBeLessThan(0.01);
  });

  // ---------------------------------------------------------------------------
  // arcSamples
  // ---------------------------------------------------------------------------

  it('default arcSamples=12: 2-pulley belt has 2*(1+12)=26 points', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    const poly = result.document.entities[result.affected[0]!] as PolylineEntity;
    expect(poly.points).toHaveLength(26);
  });

  it('arcSamples=4: coarser but still closed polyline', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      arcSamples: 4,
    });
    const poly = result.document.entities[result.affected[0]!] as PolylineEntity;
    expect(poly.points).toHaveLength(10); // 2*(1+4)
    expect(poly.closed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // position / rotation
  // ---------------------------------------------------------------------------

  it('position is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      position: [10, 20, 5],
    });
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.position).toEqual([10, 20, 5]);
  });

  it('rotation is stored on the entity', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      rotation: [0, 0, Math.PI / 4],
    });
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity.rotation[2]).toBeCloseTo(Math.PI / 4, 9);
  });

  it('different positions produce distinct entity placements', () => {
    const doc = createEmptyDocument();
    __resetIdCounter();
    const r1 = execute(doc, 'draw_belt_around', {
      pulleys: [{ center: [0, 0], radius: 4 }, { center: [10, 0], radius: 4 }],
      position: [0, 0, 0],
    });
    __resetIdCounter();
    const r2 = execute(doc, 'draw_belt_around', {
      pulleys: [{ center: [0, 0], radius: 4 }, { center: [10, 0], radius: 4 }],
      position: [100, 0, 0],
    });
    expect(r2.document.entities[r2.affected[0]!]!.position[0]).toBe(100);
    expect(r1.document.entities[r1.affected[0]!]!.position[0]).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  it('summary contains entity id, pulley count, and length', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    const id = result.affected[0]!;
    expect(result.summary).toContain(id);
    expect(result.summary).toContain('2 pulleys');
    expect(result.summary).toMatch(/length ≈/);
    expect(result.summary).toMatch(/bounds/);
  });

  // ---------------------------------------------------------------------------
  // Failure paths
  // ---------------------------------------------------------------------------

  it('pulleys.length < 2 -> no-op, affected:[]', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [{ center: [0, 0], radius: 5 }],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/at least 2/i);
  });

  it('empty pulleys array -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', { pulleys: [] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('pulley with non-positive radius -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 0 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/radius/i);
  });

  it('negative radius -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: -3 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('coincident centers -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [5, 5], radius: 2 },
        { center: [5, 5], radius: 3 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/coincident/i);
  });

  it('pulley-inside-pulley (d < |r1 - r2|) -> no-op', () => {
    const doc = createEmptyDocument();
    // d=3, r1=10, r2=1 → |r1-r2|=9 > d=3
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 10 },
        { center: [3, 0], radius: 1 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/inside|tangent/i);
  });

  it('non-finite center coordinate -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [NaN, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/non-finite/i);
  });

  it('Infinity in center -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, Infinity], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('NaN radius -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: NaN },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('arcSamples < 2 -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      arcSamples: 1,
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toMatch(/arcSamples/i);
  });

  it('arcSamples=NaN -> no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
      arcSamples: NaN,
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
    execute(doc, 'draw_belt_around', {
      pulleys: [
        { center: [0, 0], radius: 5 },
        { center: [20, 0], radius: 5 },
      ],
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('is pure — failure path does not mutate input doc', () => {
    const doc = createEmptyDocument();
    const snapshot = JSON.stringify(doc);
    execute(doc, 'draw_belt_around', {
      pulleys: [{ center: [0, 0], radius: 5 }],
    });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  // ---------------------------------------------------------------------------
  // Registry 1:1 invariant
  // ---------------------------------------------------------------------------

  it('toToolSchemas().length === listCommands().length', () => {
    expect(toToolSchemas().length).toBe(listCommands().length);
  });

  it('draw_belt_around is registered in listCommands', () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toContain('draw_belt_around');
  });
});
