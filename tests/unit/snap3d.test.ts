/**
 * Unit tests for src/ui/viewport/3d/snap3d.ts
 *
 * All functions are pure — no React, no three.js, no DOM.
 * Tests cover: vertex / edge / face-center / grid / none snap types,
 * tolerance boundary behaviour, priority resolution, no input mutation.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type {
  CadDocument,
  BoxEntity,
  CylinderEntity,
  SphereEntity,
  ExtrusionEntity,
} from '@core/model/types';
import {
  collectSnapCandidates3D,
  snap3d,
} from '../../src/ui/viewport/3d/snap3d';
import type { SnapPoint3D } from '../../src/ui/viewport/3d/snap3d';

// ---------------------------------------------------------------------------
// Document builders
// ---------------------------------------------------------------------------

function emptyDoc(): CadDocument {
  return createEmptyDocument();
}

function docWithBox(id: string, px: number, py: number, pz: number, w: number, h: number, d: number): CadDocument {
  const doc = emptyDoc();
  const entity: BoxEntity = {
    id,
    kind: 'box',
    size: [w, h, d],
    position: [px, py, pz],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return { ...doc, entities: { [id]: entity }, order: [id] };
}

function docWithCylinder(id: string, px: number, py: number, pz: number, radius: number, height: number): CadDocument {
  const doc = emptyDoc();
  const entity: CylinderEntity = {
    id,
    kind: 'cylinder',
    radius,
    height,
    position: [px, py, pz],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return { ...doc, entities: { [id]: entity }, order: [id] };
}

function docWithSphere(id: string, px: number, py: number, pz: number, radius: number): CadDocument {
  const doc = emptyDoc();
  const entity: SphereEntity = {
    id,
    kind: 'sphere',
    radius,
    position: [px, py, pz],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return { ...doc, entities: { [id]: entity }, order: [id] };
}

function docWithExtrusion(id: string, px: number, py: number, pz: number): CadDocument {
  const doc = emptyDoc();
  const entity: ExtrusionEntity = {
    id,
    kind: 'extrusion',
    profile: [[0, 0], [2, 0], [2, 2], [0, 2]],
    depth: 3,
    position: [px, py, pz],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  return { ...doc, entities: { [id]: entity }, order: [id] };
}

// ---------------------------------------------------------------------------
// collectSnapCandidates3D
// ---------------------------------------------------------------------------

describe('collectSnapCandidates3D', () => {
  it('returns empty array for document with no 3D entities', () => {
    const candidates = collectSnapCandidates3D(emptyDoc(), undefined);
    expect(candidates).toHaveLength(0);
  });

  it('returns empty array when the only entity is excluded', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, 'b1');
    expect(candidates).toHaveLength(0);
  });

  it('produces 26 candidates for a box (8 corners + 6 face-centers + 12 edge midpoints)', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    expect(candidates).toHaveLength(26);
  });

  it('box candidates include all 8 corners as "vertex" type', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const vertices = candidates.filter((c) => c.type === 'vertex');
    expect(vertices).toHaveLength(8);
  });

  it('box candidates include 6 face-centers', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const faceCenters = candidates.filter((c) => c.type === 'face-center');
    expect(faceCenters).toHaveLength(6);
  });

  it('box candidates include 12 edge midpoints', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const edges = candidates.filter((c) => c.type === 'edge');
    expect(edges).toHaveLength(12);
  });

  it('box at non-origin position has corners offset correctly', () => {
    // Box at (10, 5, 0) size (2, 2, 2) → corners between (9,4,-1) and (11,6,1).
    const doc = docWithBox('b1', 10, 5, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const vertices = candidates.filter((c) => c.type === 'vertex');
    // All vertex x values should be 9 or 11.
    for (const v of vertices) {
      expect([9, 11]).toContain(Math.round(v.x));
    }
  });

  it('cylinder produces vertex points at disc centres and rim points', () => {
    const doc = docWithCylinder('c1', 0, 0, 0, 2, 4);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const vertices = candidates.filter((c) => c.type === 'vertex');
    // 2 disc centres + 8 rim × 2 discs = 18
    expect(vertices).toHaveLength(18);
  });

  it('cylinder bottom disc centre is at entity position', () => {
    const doc = docWithCylinder('c1', 3, 1, -2, 1, 5);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const centre = candidates.find(
      (c) => c.type === 'vertex' && c.x === 3 && c.y === 1 && c.z === -2,
    );
    expect(centre).toBeDefined();
  });

  it('cylinder top disc centre is at position + height on Y', () => {
    const doc = docWithCylinder('c1', 0, 0, 0, 1, 6);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const topCentre = candidates.find(
      (c) => c.type === 'vertex' && c.x === 0 && c.y === 6 && c.z === 0,
    );
    expect(topCentre).toBeDefined();
  });

  it('sphere produces 7 snap points: centre + 6 poles', () => {
    const doc = docWithSphere('s1', 0, 0, 0, 3);
    const candidates = collectSnapCandidates3D(doc, undefined);
    expect(candidates).toHaveLength(7);
  });

  it('sphere poles are at distance == radius from centre', () => {
    const doc = docWithSphere('s1', 1, 2, 3, 5);
    const candidates = collectSnapCandidates3D(doc, undefined);
    // The centre point is at (1, 2, 3); poles are each 5 units away.
    const nonCentre = candidates.filter(
      (c) => !(c.x === 1 && c.y === 2 && c.z === 3),
    );
    for (const p of nonCentre) {
      const dx = p.x - 1;
      const dy = p.y - 2;
      const dz = p.z - 3;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      expect(d).toBeCloseTo(5);
    }
  });

  it('extrusion produces AABB-based candidates (26 = 8+6+12)', () => {
    const doc = docWithExtrusion('e1', 0, 0, 0);
    const candidates = collectSnapCandidates3D(doc, undefined);
    expect(candidates).toHaveLength(26);
  });

  it('does not include 2D entities', () => {
    const doc = createEmptyDocument();
    // Add a line entity.
    const line = {
      id: 'l1',
      kind: 'line' as const,
      start: [0, 0] as [number, number],
      end: [1, 1] as [number, number],
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      layerId: 'layer-default',
      color: '#fff',
    };
    const doc2 = { ...doc, entities: { l1: line }, order: ['l1'] };
    const candidates = collectSnapCandidates3D(doc2 as CadDocument, undefined);
    expect(candidates).toHaveLength(0);
  });

  it('does not mutate the document', () => {
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const originalOrder = [...doc.order];
    const originalEntities = { ...doc.entities };
    collectSnapCandidates3D(doc, undefined);
    expect(doc.order).toEqual(originalOrder);
    expect(doc.entities).toEqual(originalEntities);
  });

  it('accumulates candidates from multiple entities', () => {
    const doc1 = docWithBox('b1', -5, 0, 0, 2, 2, 2);
    const doc2 = docWithBox('b2', 5, 0, 0, 2, 2, 2);
    const combined: CadDocument = {
      ...emptyDoc(),
      entities: { ...doc1.entities, ...doc2.entities },
      order: ['b1', 'b2'],
    };
    const candidates = collectSnapCandidates3D(combined, undefined);
    // 26 per box × 2 boxes = 52
    expect(candidates).toHaveLength(52);
  });

  it('excludeId correctly filters out the dragged entity', () => {
    const combined: CadDocument = {
      ...emptyDoc(),
      entities: {
        ...docWithBox('b1', -5, 0, 0, 2, 2, 2).entities,
        ...docWithBox('b2', 5, 0, 0, 2, 2, 2).entities,
      },
      order: ['b1', 'b2'],
    };
    const candidates = collectSnapCandidates3D(combined, 'b1');
    // Only b2 contributes.
    expect(candidates).toHaveLength(26);
  });
});

// ---------------------------------------------------------------------------
// snap3d
// ---------------------------------------------------------------------------

describe('snap3d', () => {
  const TOLERANCE = 0.5;
  const GRID_STEP = 1;

  // Helpers
  function makeVertex(x: number, y: number, z: number): SnapPoint3D {
    return { x, y, z, type: 'vertex' };
  }
  function makeEdge(x: number, y: number, z: number): SnapPoint3D {
    return { x, y, z, type: 'edge' };
  }
  function makeFaceCenter(x: number, y: number, z: number): SnapPoint3D {
    return { x, y, z, type: 'face-center' };
  }

  it('returns "none" when no candidates and gridStep = 0', () => {
    const result = snap3d(1.3, 2.7, 0.1, [], TOLERANCE, 0);
    expect(result).toMatchObject({ type: 'none', snapped: false });
    expect(result.x).toBeCloseTo(1.3);
    expect(result.y).toBeCloseTo(2.7);
    expect(result.z).toBeCloseTo(0.1);
  });

  it('snaps to grid when no candidates and gridStep > 0', () => {
    const result = snap3d(1.3, 2.7, 0.4, [], TOLERANCE, GRID_STEP);
    expect(result).toMatchObject({ type: 'grid', snapped: true, x: 1, y: 3, z: 0 });
  });

  it('snaps to vertex within tolerance', () => {
    const candidates: SnapPoint3D[] = [makeVertex(5, 5, 5)];
    const result = snap3d(5.3, 5.1, 4.9, candidates, TOLERANCE, GRID_STEP);
    expect(result).toMatchObject({ type: 'vertex', snapped: true, x: 5, y: 5, z: 5 });
  });

  it('does not snap to vertex beyond tolerance', () => {
    const candidates: SnapPoint3D[] = [makeVertex(5, 5, 5)];
    // Distance > 0.5.
    const result = snap3d(5.4, 5.4, 5.4, candidates, TOLERANCE, GRID_STEP);
    // Distance = sqrt(3) * 0.4 ≈ 0.693 > 0.5 → grid snap instead.
    expect(result.type).toBe('grid');
  });

  it('snaps to edge within tolerance', () => {
    const candidates: SnapPoint3D[] = [makeEdge(3, 3, 3)];
    const result = snap3d(3.2, 3.1, 2.9, candidates, TOLERANCE, GRID_STEP);
    expect(result).toMatchObject({ type: 'edge', snapped: true, x: 3, y: 3, z: 3 });
  });

  it('snaps to face-center within tolerance', () => {
    const candidates: SnapPoint3D[] = [makeFaceCenter(2, 0, 2)];
    const result = snap3d(2.1, 0.1, 2.1, candidates, TOLERANCE, GRID_STEP);
    expect(result).toMatchObject({ type: 'face-center', snapped: true, x: 2, y: 0, z: 2 });
  });

  it('tolerance boundary: exactly at tolerance distance snaps', () => {
    // Place candidate exactly tolerance away.
    const candidates: SnapPoint3D[] = [makeVertex(0, 0, 0)];
    const result = snap3d(TOLERANCE, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.snapped).toBe(true);
    expect(result.type).toBe('vertex');
  });

  it('tolerance boundary: just beyond tolerance does not snap geometrically', () => {
    const candidates: SnapPoint3D[] = [makeVertex(0, 0, 0)];
    const eps = 1e-6;
    const result = snap3d(TOLERANCE + eps, 0, 0, candidates, TOLERANCE, GRID_STEP);
    // Falls back to grid.
    expect(result.type).toBe('grid');
  });

  it('vertex beats edge at equal distance (priority)', () => {
    const candidates: SnapPoint3D[] = [
      makeEdge(0, 0, 0),
      makeVertex(0, 0, 0),
    ];
    const result = snap3d(0.1, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.type).toBe('vertex');
  });

  it('edge beats face-center at equal distance (priority)', () => {
    const candidates: SnapPoint3D[] = [
      makeFaceCenter(0, 0, 0),
      makeEdge(0, 0, 0),
    ];
    const result = snap3d(0.1, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.type).toBe('edge');
  });

  it('face-center beats grid at equal distance (priority)', () => {
    // Grid snap would be at (0,0,0) — same as face-center candidate.
    const candidates: SnapPoint3D[] = [makeFaceCenter(0, 0, 0)];
    const result = snap3d(0, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.type).toBe('face-center');
  });

  it('closer candidate wins over further even if higher priority type', () => {
    // Vertex at distance 1.0 (beyond tolerance 0.5), edge at distance 0.2 (within).
    const candidates: SnapPoint3D[] = [
      makeVertex(1, 0, 0), // distance = 1.0 → beyond tolerance
      makeEdge(0.2, 0, 0), // distance = 0.2 → within tolerance
    ];
    const result = snap3d(0, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.type).toBe('edge');
    expect(result.x).toBeCloseTo(0.2);
  });

  it('returns nearest candidate when multiple are within tolerance', () => {
    const candidates: SnapPoint3D[] = [
      makeVertex(0.4, 0, 0), // distance 0.4
      makeVertex(0.1, 0, 0), // distance 0.1 (closer)
    ];
    const result = snap3d(0, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.x).toBeCloseTo(0.1);
  });

  it('does not mutate the candidates array', () => {
    const candidates: SnapPoint3D[] = [makeVertex(1, 1, 1)];
    const original = [...candidates];
    snap3d(0, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(candidates).toEqual(original);
  });

  it('does not mutate candidate point objects', () => {
    const pt: SnapPoint3D = makeVertex(2, 3, 4);
    const originalX = pt.x;
    snap3d(2, 3, 4, [pt], TOLERANCE, GRID_STEP);
    expect(pt.x).toBe(originalX);
  });

  it('grid snap rounds each axis independently', () => {
    const result = snap3d(1.7, 2.3, -0.6, [], TOLERANCE, GRID_STEP);
    expect(result).toMatchObject({ type: 'grid', snapped: true, x: 2, y: 2, z: -1 });
  });

  it('geometric snap beats grid even when grid is closer', () => {
    // Candidate at (5, 0, 0), cursor at (4.9, 0, 0) — distance 0.1 (< tolerance).
    // Grid snap at (5, 0, 0) — same point. Candidate should win as 'vertex'.
    const candidates: SnapPoint3D[] = [makeVertex(5, 0, 0)];
    const result = snap3d(4.9, 0, 0, candidates, TOLERANCE, GRID_STEP);
    expect(result.type).toBe('vertex');
  });

  it('returns "none" with raw position when no snap and no grid', () => {
    const result = snap3d(1.23, 4.56, -0.78, [], TOLERANCE, 0);
    expect(result.snapped).toBe(false);
    expect(result.type).toBe('none');
    expect(result.x).toBeCloseTo(1.23);
    expect(result.y).toBeCloseTo(4.56);
    expect(result.z).toBeCloseTo(-0.78);
  });
});

// ---------------------------------------------------------------------------
// Integration: collectSnapCandidates3D + snap3d round-trip
// ---------------------------------------------------------------------------

describe('snap3d integration with collectSnapCandidates3D', () => {
  it('snaps to the corner of a box when cursor is close', () => {
    // Box at origin, size 2×2×2 → corner at (-1,-1,-1).
    const doc = docWithBox('b1', 0, 0, 0, 2, 2, 2);
    const candidates = collectSnapCandidates3D(doc, 'moving-entity');
    // Cursor near corner (-1,-1,-1).
    const result = snap3d(-0.8, -0.9, -1.0, candidates, 0.5, 1);
    expect(result.type).toBe('vertex');
    expect(result.x).toBeCloseTo(-1);
    expect(result.y).toBeCloseTo(-1);
    expect(result.z).toBeCloseTo(-1);
  });

  it('snaps to the face-center of a box', () => {
    // Box at (0,0,0), size 4×4×4 → +X face centre at (2, 0, 0).
    const doc = docWithBox('b1', 0, 0, 0, 4, 4, 4);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const result = snap3d(1.8, 0.1, -0.1, candidates, 0.5, 1);
    expect(result.type).toBe('face-center');
    expect(result.x).toBeCloseTo(2);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });

  it('snaps to cylinder disc centre', () => {
    const doc = docWithCylinder('c1', 0, 0, 0, 2, 5);
    const candidates = collectSnapCandidates3D(doc, undefined);
    // Bottom disc centre at (0, 0, 0).
    const result = snap3d(0.1, 0.2, 0.1, candidates, 0.5, 1);
    expect(result.type).toBe('vertex');
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });

  it('snaps to sphere centre', () => {
    const doc = docWithSphere('s1', 3, 0, 0, 2);
    const candidates = collectSnapCandidates3D(doc, undefined);
    const result = snap3d(3.2, 0.1, -0.1, candidates, 0.5, 1);
    expect(result.type).toBe('vertex');
    expect(result.x).toBeCloseTo(3);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });
});
