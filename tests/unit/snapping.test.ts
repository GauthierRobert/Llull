/**
 * Unit tests for the pure snapping helpers in src/ui/viewport/2d/snapping.ts.
 *
 * These are pure functions — no React, no store, no DOM required.
 * All geometry math is deterministic and tested exhaustively here.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type {
  CadDocument,
  LineEntity,
  CircleEntity,
  RectangleEntity,
  PolylineEntity,
  ArcEntity,
} from '@core/model/types';
import {
  collectSnapCandidates,
  snap,
  applyOrthoPolar,
  snapPerpendicular,
  perpendicularFoot,
  tangentPointsToCircle,
  snapTangentToCircle,
  snapExtension,
  nearestOnSegment,
  nearestOnArc,
  collectOsnapTracking,
} from '../../src/ui/viewport/2d/snapping';

// ---------------------------------------------------------------------------
// Test document builders
// ---------------------------------------------------------------------------

function docWithLine(start: [number, number], end: [number, number]): CadDocument {
  const doc = createEmptyDocument();
  const entity: LineEntity = {
    id: 'l1',
    kind: 'line',
    start,
    end,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return {
    ...doc,
    entities: { l1: entity },
    order: ['l1'],
  };
}

function docWithCircle(center: [number, number], radius: number): CadDocument {
  const doc = createEmptyDocument();
  const entity: CircleEntity = {
    id: 'c1',
    kind: 'circle',
    center,
    radius,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return {
    ...doc,
    entities: { c1: entity },
    order: ['c1'],
  };
}

function docWithRectangle(ox: number, oy: number, width: number, height: number): CadDocument {
  const doc = createEmptyDocument();
  const entity: RectangleEntity = {
    id: 'r1',
    kind: 'rectangle',
    width,
    height,
    position: [ox, oy, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return {
    ...doc,
    entities: { r1: entity },
    order: ['r1'],
  };
}

function docWithLineAndCircle(): CadDocument {
  const lineDoc = docWithLine([0, 0], [10, 0]);
  const circle: CircleEntity = {
    id: 'c1',
    kind: 'circle',
    center: [5, 5],
    radius: 3,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return {
    ...lineDoc,
    entities: { ...lineDoc.entities, c1: circle },
    order: [...lineDoc.order, 'c1'],
  };
}

function docWithTwoLines(): CadDocument {
  const doc = createEmptyDocument();
  const l1: LineEntity = {
    id: 'l1',
    kind: 'line',
    start: [0, -5],
    end: [0, 5],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  const l2: LineEntity = {
    id: 'l2',
    kind: 'line',
    start: [-5, 0],
    end: [5, 0],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return {
    ...doc,
    entities: { l1, l2 },
    order: ['l1', 'l2'],
  };
}

// ---------------------------------------------------------------------------
// collectSnapCandidates
// ---------------------------------------------------------------------------

describe('collectSnapCandidates', () => {
  it('returns endpoint and midpoint for a line', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    const candidates = collectSnapCandidates(doc);

    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    const midpoints = candidates.filter((c) => c.type === 'midpoint');

    expect(endpoints).toHaveLength(2);
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 0, y: 0 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 10, y: 0 }));

    expect(midpoints).toHaveLength(1);
    expect(midpoints[0]).toMatchObject({ x: 5, y: 0, type: 'midpoint' });
  });

  it('returns center and cardinal-point endpoints for a circle', () => {
    const doc = docWithCircle([5, 5], 3);
    const candidates = collectSnapCandidates(doc);

    const centers = candidates.filter((c) => c.type === 'center');
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: 5, y: 5, type: 'center' });

    // Cardinal endpoints: right, left, top, bottom.
    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    expect(endpoints).toHaveLength(4);
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 8, y: 5 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 2, y: 5 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 5, y: 8 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 5, y: 2 }));
  });

  it('returns corners, edge midpoints, and center for a rectangle', () => {
    const doc = docWithRectangle(0, 0, 10, 4);
    const candidates = collectSnapCandidates(doc);

    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    expect(endpoints).toHaveLength(4);
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 0, y: 0 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 10, y: 0 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 10, y: 4 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 0, y: 4 }));

    const midpoints = candidates.filter((c) => c.type === 'midpoint');
    expect(midpoints).toHaveLength(4);
    expect(midpoints).toContainEqual(expect.objectContaining({ x: 5, y: 0 }));
    expect(midpoints).toContainEqual(expect.objectContaining({ x: 5, y: 4 }));

    const centers = candidates.filter((c) => c.type === 'center');
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: 5, y: 2, type: 'center' });
  });

  it('returns intersection for two crossing lines', () => {
    const doc = docWithTwoLines();
    const candidates = collectSnapCandidates(doc);

    const intersections = candidates.filter((c) => c.type === 'intersection');
    expect(intersections).toHaveLength(1);
    expect(intersections[0]!.x).toBeCloseTo(0);
    expect(intersections[0]!.y).toBeCloseTo(0);
  });

  it('collects endpoints from a doc with both a line and a circle', () => {
    const doc = docWithLineAndCircle();
    const candidates = collectSnapCandidates(doc);

    // Should have both line endpoints and circle candidates.
    const types = new Set(candidates.map((c) => c.type));
    expect(types.has('endpoint')).toBe(true);
    expect(types.has('center')).toBe(true);
  });

  it('respects CollectOpts — can disable specific types', () => {
    const doc = docWithLine([0, 0], [10, 0]);

    const noEndpoints = collectSnapCandidates(doc, { endpoints: false });
    expect(noEndpoints.filter((c) => c.type === 'endpoint')).toHaveLength(0);
    expect(noEndpoints.filter((c) => c.type === 'midpoint')).toHaveLength(1);

    const noMidpoints = collectSnapCandidates(doc, { midpoints: false });
    expect(noMidpoints.filter((c) => c.type === 'midpoint')).toHaveLength(0);
    expect(noMidpoints.filter((c) => c.type === 'endpoint')).toHaveLength(2);
  });

  it('returns empty array for an empty document', () => {
    const doc = createEmptyDocument();
    expect(collectSnapCandidates(doc)).toHaveLength(0);
  });

  it('applies position offset to line endpoints', () => {
    const doc = createEmptyDocument();
    const entity: LineEntity = {
      id: 'loffset',
      kind: 'line',
      start: [0, 0],
      end: [1, 0],
      position: [5, 10, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const d: CadDocument = { ...doc, entities: { loffset: entity }, order: ['loffset'] };
    const candidates = collectSnapCandidates(d);
    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 5, y: 10 }));
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 6, y: 10 }));
  });

  it('returns arc center, start/end endpoints, and midpoint', () => {
    const doc = createEmptyDocument();
    const entity: ArcEntity = {
      id: 'a1',
      kind: 'arc',
      center: [0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: Math.PI,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const d: CadDocument = { ...doc, entities: { a1: entity }, order: ['a1'] };
    const candidates = collectSnapCandidates(d);

    const centers = candidates.filter((c) => c.type === 'center');
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ x: 0, y: 0 });

    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    // start (angle=0): [5, 0], end (angle=π): [-5, 0]
    expect(endpoints).toContainEqual(expect.objectContaining({ x: 5, y: 0 }));
    expect(endpoints.some((e) => Math.abs(e.x - (-5)) < 1e-6 && Math.abs(e.y) < 1e-6)).toBe(true);

    const midpoints = candidates.filter((c) => c.type === 'midpoint');
    // midAngle = π/2 → [0, 5]
    expect(midpoints).toHaveLength(1);
    expect(midpoints[0]!.x).toBeCloseTo(0);
    expect(midpoints[0]!.y).toBeCloseTo(5);
  });

  it('arc midpoint follows the swept direction across the 0/2π wrap', () => {
    const doc = createEmptyDocument();
    // Arc from 3π/2 sweeping CCW to 5π/2 (== π/2): the swept midpoint is at 2π → [5,0],
    // NOT the naive average (3π/2+5π/2)/2 = 2π either — use a clearer wrap case:
    // start=7π/4, end=9π/4 (==π/4): sweep=π/2, mid=7π/4+π/4=2π → [5,0].
    const entity: ArcEntity = {
      id: 'aw',
      kind: 'arc',
      center: [0, 0],
      radius: 5,
      startAngle: (7 * Math.PI) / 4,
      endAngle: (9 * Math.PI) / 4,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const d: CadDocument = { ...doc, entities: { aw: entity }, order: ['aw'] };
    const midpoints = collectSnapCandidates(d).filter((c) => c.type === 'midpoint');
    expect(midpoints).toHaveLength(1);
    // Swept midpoint at 2π → [5, 0]. The naive average (7π/4+9π/4)/2 = 2π gives the same
    // here, so use the assertion that distinguishes: it must lie ON the arc (x=5,y=0),
    // not the opposite side (x=-5).
    expect(midpoints[0]!.x).toBeCloseTo(5);
    expect(midpoints[0]!.y).toBeCloseTo(0);
  });

  it('returns vertices and segment midpoints for a polyline', () => {
    const doc = createEmptyDocument();
    const entity: PolylineEntity = {
      id: 'p1',
      kind: 'polyline',
      points: [[0, 0], [4, 0], [4, 3]],
      closed: false,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const d: CadDocument = { ...doc, entities: { p1: entity }, order: ['p1'] };
    const candidates = collectSnapCandidates(d);

    const endpoints = candidates.filter((c) => c.type === 'endpoint');
    expect(endpoints).toHaveLength(3);

    const midpoints = candidates.filter((c) => c.type === 'midpoint');
    expect(midpoints).toHaveLength(2);
    // Seg 1 midpoint: [2, 0]; Seg 2 midpoint: [4, 1.5]
    expect(midpoints).toContainEqual(expect.objectContaining({ x: 2, y: 0 }));
    expect(midpoints).toContainEqual(expect.objectContaining({ x: 4, y: 1.5 }));
  });
});

// ---------------------------------------------------------------------------
// snap
// ---------------------------------------------------------------------------

describe('snap', () => {
  const GRID = 1;
  const TOL = 0.5;

  it('snaps to the nearest endpoint within tolerance', () => {
    const candidates = [{ x: 5, y: 0, type: 'endpoint' as const }];
    const result = snap([5.1, 0.1], candidates, GRID, TOL);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe('endpoint');
    expect(result.x).toBe(5);
    expect(result.y).toBe(0);
  });

  it('does not snap when cursor is beyond tolerance', () => {
    const candidates = [{ x: 5, y: 0, type: 'endpoint' as const }];
    const result = snap([5.6, 0.6], candidates, GRID, TOL);
    // Falls back to grid (gridSize=1 → rounds to 6,1).
    expect(result.type).toBe('grid');
    expect(result.x).toBe(6);
    expect(result.y).toBe(1);
  });

  it('falls back to the nearest grid point when no geometric snap is within tolerance', () => {
    const result = snap([3.7, 2.3], [], GRID, TOL);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe('grid');
    expect(result.x).toBe(4);
    expect(result.y).toBe(2);
  });

  it('prefers endpoint over midpoint at equal distance', () => {
    const candidates = [
      { x: 1, y: 0, type: 'midpoint' as const },
      { x: 1, y: 0, type: 'endpoint' as const },
    ];
    const result = snap([1, 0], candidates, GRID, TOL);
    expect(result.type).toBe('endpoint');
  });

  it('prefers midpoint over center at equal distance', () => {
    const candidates = [
      { x: 2, y: 2, type: 'center' as const },
      { x: 2, y: 2, type: 'midpoint' as const },
    ];
    const result = snap([2, 2], candidates, GRID, TOL);
    expect(result.type).toBe('midpoint');
  });

  it('prefers center over intersection at equal distance', () => {
    const candidates = [
      { x: 0, y: 0, type: 'intersection' as const },
      { x: 0, y: 0, type: 'center' as const },
    ];
    const result = snap([0, 0], candidates, GRID, TOL);
    expect(result.type).toBe('center');
  });

  it('prefers geometric snap over grid', () => {
    const candidates = [{ x: 3, y: 3, type: 'center' as const }];
    // cursor is at 3.2, 3.2 — within tolerance of center AND near grid point 3,3
    const result = snap([3.2, 3.2], candidates, GRID, TOL);
    expect(result.type).toBe('center');
    expect(result.x).toBe(3);
    expect(result.y).toBe(3);
  });

  it('snaps to the closer of two candidates', () => {
    const candidates = [
      { x: 0, y: 0, type: 'endpoint' as const },
      { x: 10, y: 0, type: 'endpoint' as const },
    ];
    const result = snap([0.2, 0], candidates, GRID, TOL);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('returns snapped=false and type=null when gridSize=0 and no candidates match', () => {
    const result = snap([1.7, 2.3], [], 0, TOL);
    expect(result.snapped).toBe(false);
    expect(result.type).toBeNull();
    expect(result.x).toBeCloseTo(1.7);
    expect(result.y).toBeCloseTo(2.3);
  });
});

// ---------------------------------------------------------------------------
// applyOrthoPolar
// ---------------------------------------------------------------------------

describe('applyOrthoPolar', () => {
  it('returns cursor unchanged when both ortho and polar are false', () => {
    const origin: [number, number] = [0, 0];
    const cursor: [number, number] = [3, 4];
    const result = applyOrthoPolar(origin, cursor, { ortho: false, polar: false });
    expect(result).toEqual([3, 4]);
  });

  it('constrains to horizontal when cursor is more horizontal (ortho)', () => {
    const origin: [number, number] = [0, 0];
    // dx=5 > dy=1 → should constrain to horizontal (y→0)
    const result = applyOrthoPolar(origin, [5, 1], { ortho: true, polar: false });
    expect(result[0]).toBeCloseTo(5);
    expect(result[1]).toBeCloseTo(0);
  });

  it('constrains to vertical when cursor is more vertical (ortho)', () => {
    const origin: [number, number] = [0, 0];
    // dx=1, dy=5 → should constrain to vertical (x→0)
    const result = applyOrthoPolar(origin, [1, 5], { ortho: true, polar: false });
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(5);
  });

  it('handles a non-zero origin correctly (ortho)', () => {
    const origin: [number, number] = [3, 3];
    // cursor [8, 4] → dx=5, dy=1 → horizontal constrain → [8, 3]
    const result = applyOrthoPolar(origin, [8, 4], { ortho: true, polar: false });
    expect(result[0]).toBeCloseTo(8);
    expect(result[1]).toBeCloseTo(3);
  });

  it('snaps to the nearest polar angle increment (polar=true, increment=15°)', () => {
    const origin: [number, number] = [0, 0];
    // angle ≈ 22.5°, nearest 15° increment → 30°
    const length = 5;
    const angle = (22.5 * Math.PI) / 180;
    const cursor: [number, number] = [length * Math.cos(angle), length * Math.sin(angle)];
    const result = applyOrthoPolar(origin, cursor, {
      ortho: false,
      polar: true,
      polarIncrement: (15 * Math.PI) / 180,
    });
    const expectedAngle = (30 * Math.PI) / 180;
    expect(result[0]).toBeCloseTo(length * Math.cos(expectedAngle));
    expect(result[1]).toBeCloseTo(length * Math.sin(expectedAngle));
  });

  it('snaps to 0° for a nearly horizontal cursor (polar)', () => {
    const origin: [number, number] = [0, 0];
    const cursor: [number, number] = [5, 0.1];
    const result = applyOrthoPolar(origin, cursor, {
      ortho: false,
      polar: true,
      polarIncrement: (15 * Math.PI) / 180,
    });
    // 0° snap → [length, 0]
    const length = Math.sqrt(5 * 5 + 0.1 * 0.1);
    expect(result[0]).toBeCloseTo(length);
    expect(result[1]).toBeCloseTo(0);
  });

  it('ortho takes precedence when both ortho and polar are true', () => {
    const origin: [number, number] = [0, 0];
    const result = applyOrthoPolar(origin, [5, 1], { ortho: true, polar: true });
    // Ortho branch: constrain to horizontal → [5, 0]
    expect(result[0]).toBeCloseTo(5);
    expect(result[1]).toBeCloseTo(0);
  });

  it('returns cursor unchanged when cursor is exactly at origin', () => {
    const origin: [number, number] = [3, 4];
    const result = applyOrthoPolar(origin, [3, 4], { ortho: true, polar: false });
    expect(result).toEqual([3, 4]);
  });

  it('treats a 0 polarIncrement as the 15° default (never returns NaN)', () => {
    const origin: [number, number] = [0, 0];
    const length = 5;
    const angle = (22.5 * Math.PI) / 180;
    const cursor: [number, number] = [length * Math.cos(angle), length * Math.sin(angle)];
    const result = applyOrthoPolar(origin, cursor, { ortho: false, polar: true, polarIncrement: 0 });
    expect(Number.isNaN(result[0])).toBe(false);
    expect(Number.isNaN(result[1])).toBe(false);
    // Falls back to 15° increment → nearest is 30°.
    const expected = (30 * Math.PI) / 180;
    expect(result[0]).toBeCloseTo(length * Math.cos(expected));
    expect(result[1]).toBeCloseTo(length * Math.sin(expected));
  });
});

// ---------------------------------------------------------------------------
// perpendicularFoot
// ---------------------------------------------------------------------------

describe('perpendicularFoot', () => {
  it('returns the foot on a horizontal segment', () => {
    // Segment [0,0]→[10,0], point [5, 3] → foot at [5, 0]
    const result = perpendicularFoot(5, 3, 0, 0, 10, 0);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(5);
    expect(result![1]).toBeCloseTo(0);
  });

  it('returns the foot outside the segment when t < 0', () => {
    // Segment [0,0]→[10,0], point [-2, 3] → foot at [-2, 0] (outside segment)
    const result = perpendicularFoot(-2, 3, 0, 0, 10, 0);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(-2);
    expect(result![1]).toBeCloseTo(0);
  });

  it('returns null for a degenerate zero-length segment', () => {
    expect(perpendicularFoot(5, 5, 3, 3, 3, 3)).toBeNull();
  });

  it('returns the foot on a diagonal segment', () => {
    // Segment [0,0]→[4,4], point [4, 0] → foot at [2, 2]
    const result = perpendicularFoot(4, 0, 0, 0, 4, 4);
    expect(result).not.toBeNull();
    expect(result![0]).toBeCloseTo(2);
    expect(result![1]).toBeCloseTo(2);
  });
});

// ---------------------------------------------------------------------------
// snapPerpendicular
// ---------------------------------------------------------------------------

describe('snapPerpendicular', () => {
  it('returns foot within segment (happy path)', () => {
    // from=[5,3], segment [0,0]→[10,0] → foot at [5,0], t=0.5 ∈ [0,1]
    const result = snapPerpendicular([5, 3], 0, 0, 10, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('perpendicular');
    expect(result!.x).toBeCloseTo(5);
    expect(result!.y).toBeCloseTo(0);
  });

  it('returns null when foot is outside segment (t < 0)', () => {
    // from=[-2, 3], segment [0,0]→[10,0] → t = -0.2 → outside
    const result = snapPerpendicular([-2, 3], 0, 0, 10, 0);
    expect(result).toBeNull();
  });

  it('returns null when foot is outside segment (t > 1)', () => {
    // from=[12, 3], segment [0,0]→[10,0] → t = 1.2 → outside
    const result = snapPerpendicular([12, 3], 0, 0, 10, 0);
    expect(result).toBeNull();
  });

  it('returns null when from is null (no previous point)', () => {
    expect(snapPerpendicular(null, 0, 0, 10, 0)).toBeNull();
  });

  it('returns null for a degenerate zero-length segment', () => {
    expect(snapPerpendicular([5, 5], 3, 3, 3, 3)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tangentPointsToCircle
// ---------------------------------------------------------------------------

describe('tangentPointsToCircle', () => {
  it('returns 2 tangent points from an external point', () => {
    // Circle at origin r=1, point at (2, 0). d=2, alpha=acos(0.5)=60°
    // T1 = [cos(60°), sin(60°)] = [0.5, √3/2]
    // T2 = [cos(-60°), sin(-60°)] = [0.5, -√3/2]
    const pts = tangentPointsToCircle(2, 0, 0, 0, 1);
    expect(pts).toHaveLength(2);
    expect(pts[0]![0]).toBeCloseTo(0.5);
    expect(Math.abs(pts[0]![1])).toBeCloseTo(Math.sqrt(3) / 2);
    expect(pts[1]![0]).toBeCloseTo(0.5);
    expect(Math.abs(pts[1]![1])).toBeCloseTo(Math.sqrt(3) / 2);
    // Verify tangent: (T-C)·(P-T) = 0
    for (const [tx, ty] of pts) {
      const dot = tx * (2 - tx) + ty * (0 - ty);
      expect(dot).toBeCloseTo(0);
    }
  });

  it('returns [] when point is strictly inside the circle', () => {
    // Circle at origin r=5, point at (2, 0) — d=2 < r=5
    expect(tangentPointsToCircle(2, 0, 0, 0, 5)).toHaveLength(0);
  });

  it('returns 2 points when point is exactly on the circle edge (d ≈ r)', () => {
    // d == r within tolerance → still returns 2 (alpha ≈ 0 → both points collapse to same)
    const pts = tangentPointsToCircle(1, 0, 0, 0, 1);
    // d = 1 = r, acos(1) = 0, so both points = [1, 0] = the external point itself
    expect(pts).toHaveLength(2);
    expect(pts[0]![0]).toBeCloseTo(1);
    expect(pts[0]![1]).toBeCloseTo(0);
  });

  it('returns [] when point is at the center (degenerate)', () => {
    expect(tangentPointsToCircle(0, 0, 0, 0, 3)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// snapTangentToCircle
// ---------------------------------------------------------------------------

describe('snapTangentToCircle', () => {
  it('returns 2 SnapPoints from an external point', () => {
    const snaps = snapTangentToCircle([2, 0], 0, 0, 1);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]!.type).toBe('tangent');
    expect(snaps[1]!.type).toBe('tangent');
  });

  it('returns [] when from is null', () => {
    expect(snapTangentToCircle(null, 0, 0, 1)).toHaveLength(0);
  });

  it('returns [] when from is inside the circle', () => {
    expect(snapTangentToCircle([1, 0], 0, 0, 5)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// snapExtension
// ---------------------------------------------------------------------------

describe('snapExtension', () => {
  it('returns extension snap beyond the end of segment (t > 1)', () => {
    // Segment [0,0]→[10,0], cursor at [12,0] → t=1.2 → foot at [12,0]
    const result = snapExtension(12, 0, 0, 0, 10, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('extension');
    expect(result!.x).toBeCloseTo(12);
    expect(result!.y).toBeCloseTo(0);
  });

  it('returns extension snap before the start of segment (t < 0)', () => {
    // Segment [0,0]→[10,0], cursor at [-3, 0] → t=-0.3 → foot at [-3, 0]
    const result = snapExtension(-3, 0, 0, 0, 10, 0);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('extension');
    expect(result!.x).toBeCloseTo(-3);
    expect(result!.y).toBeCloseTo(0);
  });

  it('returns null when cursor projects onto the segment (t in [0,1])', () => {
    // Segment [0,0]→[10,0], cursor at [5, 2] → t=0.5 → within segment
    const result = snapExtension(5, 2, 0, 0, 10, 0);
    expect(result).toBeNull();
  });

  it('returns null for a degenerate zero-length segment', () => {
    expect(snapExtension(5, 5, 3, 3, 3, 3)).toBeNull();
  });

  it('returns extension point on diagonal segment', () => {
    // Segment [0,0]→[4,4], cursor at [6, 6] → t=1.5, foot at [6, 6]
    const result = snapExtension(6, 6, 0, 0, 4, 4);
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(6);
    expect(result!.y).toBeCloseTo(6);
  });
});

// ---------------------------------------------------------------------------
// nearestOnSegment
// ---------------------------------------------------------------------------

describe('nearestOnSegment', () => {
  it('returns the projected foot when cursor is perpendicular to middle of segment', () => {
    // Segment [0,0]→[10,0], cursor [5, 3] → [5, 0]
    const [x, y] = nearestOnSegment(5, 3, 0, 0, 10, 0);
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(0);
  });

  it('clamps to start when cursor is before the segment', () => {
    const [x, y] = nearestOnSegment(-3, 2, 0, 0, 10, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
  });

  it('clamps to end when cursor is beyond the segment', () => {
    const [x, y] = nearestOnSegment(15, 2, 0, 0, 10, 0);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(0);
  });

  it('returns segment start for a degenerate zero-length segment', () => {
    const [x, y] = nearestOnSegment(5, 5, 3, 3, 3, 3);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
// nearestOnArc
// ---------------------------------------------------------------------------

describe('nearestOnArc', () => {
  it('returns radial foot for a full circle', () => {
    // Circle at origin r=5, cursor at [3, 4] → d=5 → foot at [3, 4]
    const [x, y] = nearestOnArc(3, 4, 0, 0, 5, 0, 0, true);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(4);
  });

  it('returns radial foot within arc sweep', () => {
    // Arc at origin r=5, from 0 to π (upper half). Cursor at [3, 4] → angle≈53° → within [0,π]
    const [x, y] = nearestOnArc(3, 4, 0, 0, 5, 0, Math.PI, false);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(4);
  });

  it('clamps to nearest arc endpoint when cursor angle is outside the sweep', () => {
    // Arc from π/4 to 3π/4 (sweep = π/2, upper half).
    // Cursor directly below at [0,-5] → rawAngle = -π/2.
    // Offset from startAngle (π/4): (-π/2 - π/4 + 2π) % 2π = 5π/4.
    // 5π/4 > sweep(π/2) → clamp to π/2 → clamped angle = π/4 + π/2 = 3π/4 (the end).
    const [x, y] = nearestOnArc(0, -5, 0, 0, 5, Math.PI / 4, (3 * Math.PI) / 4, false);
    expect(x).toBeCloseTo(5 * Math.cos((3 * Math.PI) / 4));
    expect(y).toBeCloseTo(5 * Math.sin((3 * Math.PI) / 4));
  });
});

// ---------------------------------------------------------------------------
// collectOsnapTracking
// ---------------------------------------------------------------------------

describe('collectOsnapTracking', () => {
  it('returns empty array when no acquired points', () => {
    const result = collectOsnapTracking([5, 5], [], {
      acquiredPoints: [],
    });
    expect(result).toHaveLength(0);
  });

  it('projects cursor onto tracking line from a single acquired point (ortho)', () => {
    // Acquired point at [0,0], cursor at [3, 1] → closest ortho direction is horizontal (0°)
    // → tracking foot at [3, 0]
    const result = collectOsnapTracking([3, 1], [{ x: 0, y: 0 }], {
      acquiredPoints: [{ x: 0, y: 0 }],
      orthoOnly: true,
    });
    expect(result.length).toBeGreaterThan(0);
    const horiz = result.find((p) => Math.abs(p.y) < 0.1 && Math.abs(p.x - 3) < 0.1);
    expect(horiz).toBeDefined();
    expect(horiz!.type).toBe('osnap-tracking');
  });

  it('returns intersection of two tracking lines from two acquired points', () => {
    // Acquired: [0,0] with horizontal tracking, [0,5] with horizontal tracking.
    // Their tracking lines both horizontal (y=0 and y=5) — parallel, no intersection.
    // Use orthogonal acquired points: A=[0,0] cursor→right, B=[5,0] cursor→up.
    // Cursor somewhere around [5,5].
    // Tracking from A=[0,0]: horizontal → y=0 line
    // Tracking from B=[5,0]: vertical → x=5 line
    // Intersection: [5, 0] ... wait, let me use a clear case:
    // A at [0,0], cursor=[5,5], angle=45° → snapped to 45° (polar)
    // B at [10,0], cursor=[5,5], angle=135° → snapped to 135°
    // Intersection of lines at 45° from [0,0] and 135° from [10,0] → [5,5]
    const result = collectOsnapTracking([5, 5], [{ x: 0, y: 0 }, { x: 10, y: 0 }], {
      acquiredPoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      polarIncrement: Math.PI / 4, // 45° increments
    });
    // Should contain a candidate near [5, 5]
    const intersection = result.find(
      (p) => Math.abs(p.x - 5) < 0.5 && Math.abs(p.y - 5) < 0.5,
    );
    expect(intersection).toBeDefined();
    expect(intersection!.type).toBe('osnap-tracking');
  });
});

// ---------------------------------------------------------------------------
// collectSnapCandidates — advanced snaps wired in
// ---------------------------------------------------------------------------

describe('collectSnapCandidates — advanced snaps', () => {
  it('emits perpendicular snap for a line when fromPoint is provided', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    // from=[5, 3] → foot on [0,0]→[10,0] is at [5, 0], t=0.5 ∈ [0,1]
    const candidates = collectSnapCandidates(doc, {}, [5, 3]);
    const perps = candidates.filter((c) => c.type === 'perpendicular');
    expect(perps.length).toBeGreaterThan(0);
    const foot = perps.find((p) => Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y) < 1e-6);
    expect(foot).toBeDefined();
  });

  it('does not emit perpendicular snap when foot is outside the segment', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    // from=[-5, 3] → t = -0.5 → outside segment → no perpendicular
    const candidates = collectSnapCandidates(doc, {}, [-5, 3]);
    const perps = candidates.filter((c) => c.type === 'perpendicular');
    expect(perps).toHaveLength(0);
  });

  it('emits tangent snaps for a circle when fromPoint is provided outside', () => {
    const doc = docWithCircle([0, 0], 1);
    // from=[2, 0] → external → 2 tangent points
    const candidates = collectSnapCandidates(doc, {}, [2, 0]);
    const tangents = candidates.filter((c) => c.type === 'tangent');
    expect(tangents).toHaveLength(2);
  });

  it('does not emit tangent snaps when fromPoint is inside circle', () => {
    const doc = docWithCircle([0, 0], 5);
    // from=[2, 0] → inside circle (d=2 < r=5) → no tangents
    const candidates = collectSnapCandidates(doc, {}, [2, 0]);
    const tangents = candidates.filter((c) => c.type === 'tangent');
    expect(tangents).toHaveLength(0);
  });

  it('emits extension snap beyond segment when cursorPoint is provided', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    // cursor=[12, 0] → t=1.2 > 1 → extension
    const candidates = collectSnapCandidates(doc, {}, null, [12, 0]);
    const extensions = candidates.filter((c) => c.type === 'extension');
    expect(extensions.length).toBeGreaterThan(0);
    expect(extensions[0]!.x).toBeCloseTo(12);
    expect(extensions[0]!.y).toBeCloseTo(0);
  });

  it('emits nearest snap on segment when cursorPoint is provided', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    // cursor=[5, 3] → nearest on segment = [5, 0]
    const candidates = collectSnapCandidates(doc, {}, null, [5, 3]);
    const nearbys = candidates.filter((c) => c.type === 'nearest');
    expect(nearbys.length).toBeGreaterThan(0);
    const pt = nearbys.find((p) => Math.abs(p.x - 5) < 1e-6 && Math.abs(p.y) < 1e-6);
    expect(pt).toBeDefined();
  });

  it('respects CollectOpts — can disable perpendiculars', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    const candidates = collectSnapCandidates(doc, { perpendiculars: false }, [5, 3]);
    expect(candidates.filter((c) => c.type === 'perpendicular')).toHaveLength(0);
  });

  it('respects CollectOpts — can disable tangents', () => {
    const doc = docWithCircle([0, 0], 1);
    const candidates = collectSnapCandidates(doc, { tangents: false }, [2, 0]);
    expect(candidates.filter((c) => c.type === 'tangent')).toHaveLength(0);
  });

  it('respects CollectOpts — can disable extensions', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    const candidates = collectSnapCandidates(doc, { extensions: false }, null, [12, 0]);
    expect(candidates.filter((c) => c.type === 'extension')).toHaveLength(0);
  });

  it('respects CollectOpts — can disable nearest', () => {
    const doc = docWithLine([0, 0], [10, 0]);
    const candidates = collectSnapCandidates(doc, { nearest: false }, null, [5, 3]);
    expect(candidates.filter((c) => c.type === 'nearest')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// snap priority — new types lower priority than classic ones
// ---------------------------------------------------------------------------

describe('snap priority — advanced types', () => {
  it('prefers endpoint over perpendicular at equal distance', () => {
    const candidates = [
      { x: 5, y: 0, type: 'perpendicular' as const },
      { x: 5, y: 0, type: 'endpoint' as const },
    ];
    const result = snap([5, 0], candidates, 1, 0.5);
    expect(result.type).toBe('endpoint');
  });

  it('prefers intersection over perpendicular at equal distance', () => {
    const candidates = [
      { x: 0, y: 0, type: 'perpendicular' as const },
      { x: 0, y: 0, type: 'intersection' as const },
    ];
    const result = snap([0, 0], candidates, 1, 0.5);
    expect(result.type).toBe('intersection');
  });

  it('prefers perpendicular over tangent at equal distance', () => {
    const candidates = [
      { x: 5, y: 0, type: 'tangent' as const },
      { x: 5, y: 0, type: 'perpendicular' as const },
    ];
    const result = snap([5, 0], candidates, 1, 0.5);
    expect(result.type).toBe('perpendicular');
  });

  it('prefers tangent over extension at equal distance', () => {
    const candidates = [
      { x: 5, y: 0, type: 'extension' as const },
      { x: 5, y: 0, type: 'tangent' as const },
    ];
    const result = snap([5, 0], candidates, 1, 0.5);
    expect(result.type).toBe('tangent');
  });

  it('prefers extension over nearest at equal distance', () => {
    const candidates = [
      { x: 5, y: 0, type: 'nearest' as const },
      { x: 5, y: 0, type: 'extension' as const },
    ];
    const result = snap([5, 0], candidates, 1, 0.5);
    expect(result.type).toBe('extension');
  });

  it('prefers nearest over osnap-tracking at equal distance', () => {
    const candidates = [
      { x: 5, y: 0, type: 'osnap-tracking' as const },
      { x: 5, y: 0, type: 'nearest' as const },
    ];
    const result = snap([5, 0], candidates, 1, 0.5);
    expect(result.type).toBe('nearest');
  });

  it('prefers osnap-tracking over grid', () => {
    // cursor at [5.1, 0.1] — within tolerance of tracking point at [5, 0]
    const candidates = [{ x: 5, y: 0, type: 'osnap-tracking' as const }];
    const result = snap([5.1, 0.1], candidates, 1, 0.5);
    expect(result.type).toBe('osnap-tracking');
  });
});
