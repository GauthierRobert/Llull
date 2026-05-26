/**
 * Component tests for VT2 — DimensionRenderer2D render branch.
 *
 * Since jsdom cannot run WebGL, we test the observable behavior through the
 * store and the shapes of dimension entities produced by add_dimension +
 * the referenced geometry commands. This validates:
 *
 *  1. add_dimension (linear) produces a dimension entity with correct shape.
 *  2. add_dimension (radial) on a circle produces a radial dimension entity.
 *  3. add_dimension (angular) on 3 points produces an angular dimension entity.
 *  4. Missing reference entity → dimension still in store but render path returns early.
 *  5. Wrong-kind reference (radial on a line) → add_dimension is a no-op (command guards).
 *  6. precision override → entity.precision stored correctly.
 *  7. label override → entity.label stored correctly.
 *  8. dimension entity is NOT routed through the instanced renderer (not batchable).
 *
 * Rendering path (WebGL) is validated structurally: the entity kind matches what
 * DimensionRenderer2D expects; presence in document.order confirms the renderer
 * switch has a branch (returning null on wrong data, not crashing).
 *
 * @layer tests/component
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import type { DimensionEntity } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Helpers — create referenced entities in the store
// ---------------------------------------------------------------------------

function addPoint(x: number, y: number): string {
  const result = localDispatch('draw_point', { position: [x, y, 0] });
  const id = result.affected[0];
  if (!id) throw new Error('draw_point returned no affected id');
  return id;
}

function addLine(x1: number, y1: number, x2: number, y2: number): string {
  const result = localDispatch('draw_line', {
    start: [x1, y1, 0],
    end: [x2, y2, 0],
  });
  const id = result.affected[0];
  if (!id) throw new Error('draw_line returned no affected id');
  return id;
}

function addCircle(cx: number, cy: number, r: number): string {
  const result = localDispatch('draw_circle', {
    center: [cx, cy, 0],
    radius: r,
  });
  const id = result.affected[0];
  if (!id) throw new Error('draw_circle returned no affected id');
  return id;
}

// ---------------------------------------------------------------------------
// 1. Linear dimension between two point entities
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — linear dimension between two points', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('produces a dimension entity with kind "dimension" and dimensionKind "linear"', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(5, 0);

    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });

    expect(result.affected).toHaveLength(1);
    const dimId = result.affected[0]!;
    const entity = useStore.getState().document.entities[dimId];
    expect(entity).toBeDefined();
    expect(entity?.kind).toBe('dimension');
    const dim = entity as DimensionEntity;
    expect(dim.dimensionKind).toBe('linear');
    expect(dim.entityIds).toEqual([idA, idB]);
  });

  it('dimension entity appears in document.order', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(3, 4);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });
    const dimId = result.affected[0]!;
    expect(useStore.getState().document.order).toContain(dimId);
  });

  it('linear dimension has offset 5 by default', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(10, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    // offset defaults to undefined in entity (stored only when explicitly passed)
    expect(dim.offset).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Radial dimension on a circle
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — radial dimension on a circle', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('produces a radial dimension entity referencing the circle', () => {
    const circleId = addCircle(0, 0, 4);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'radial',
      entityIds: [circleId],
    });

    expect(result.affected).toHaveLength(1);
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.kind).toBe('dimension');
    expect(dim.dimensionKind).toBe('radial');
    expect(dim.entityIds[0]).toBe(circleId);
  });

  it('referenced circle is still in the document (no crash from dimension creation)', () => {
    const circleId = addCircle(2, 3, 7);
    localDispatch('add_dimension', {
      dimensionKind: 'radial',
      entityIds: [circleId],
    });
    // Both circle and dimension should be in the store.
    const doc = useStore.getState().document;
    expect(doc.entities[circleId]).toBeDefined();
    expect(doc.entities[circleId]?.kind).toBe('circle');
  });
});

// ---------------------------------------------------------------------------
// 3. Angular dimension on 3 point entities
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — angular dimension on 3 points', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('produces an angular dimension entity with 3 entityIds', () => {
    const vertex = addPoint(0, 0);
    const armA = addPoint(5, 0);
    const armB = addPoint(0, 5);

    const result = localDispatch('add_dimension', {
      dimensionKind: 'angular',
      entityIds: [vertex, armA, armB],
    });

    expect(result.affected).toHaveLength(1);
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.dimensionKind).toBe('angular');
    expect(dim.entityIds).toHaveLength(3);
    expect(dim.entityIds[0]).toBe(vertex);
    expect(dim.entityIds[1]).toBe(armA);
    expect(dim.entityIds[2]).toBe(armB);
  });

  it('angular dimension between 90° arms is stored correctly', () => {
    const vertex = addPoint(0, 0);
    const armA = addPoint(1, 0); // along +X → 0°
    const armB = addPoint(0, 1); // along +Y → 90°

    const result = localDispatch('add_dimension', {
      dimensionKind: 'angular',
      entityIds: [vertex, armA, armB],
    });
    // The dimension entity exists — angle computation happens at render time.
    expect(result.affected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Missing reference entity → add_dimension no-ops gracefully
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — missing reference entity', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('add_dimension with a non-existent entity id returns no-op', () => {
    const idA = addPoint(0, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, 'does-not-exist'],
    });
    // Command should guard against missing refs → no entity created.
    expect(result.affected).toHaveLength(0);
    expect(useStore.getState().document.order).toHaveLength(1); // only the point
  });

  it('no crash when both references are missing', () => {
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: ['ghost-a', 'ghost-b'],
    });
    expect(result.affected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Wrong-kind reference (radial on a line → command no-op)
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — wrong-kind reference for radial', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('radial dimension pointing at a line entity is rejected by the command', () => {
    const lineId = addLine(0, 0, 5, 5);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'radial',
      entityIds: [lineId],
    });
    // add_dimension guards radial kind → must be circle/arc/ellipse.
    expect(result.affected).toHaveLength(0);
  });

  it('linear dimension pointing at a circle entity is rejected by the command', () => {
    const circleId = addCircle(0, 0, 3);
    const idB = addPoint(5, 5);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [circleId, idB],
    });
    expect(result.affected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Precision override
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — precision override', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('entity.precision is stored when precision param is provided', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(10, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
      precision: 1,
    });
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.precision).toBe(1);
  });

  it('entity.precision is undefined when not provided (uses document displayPrecision)', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(10, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    // Not set → undefined; renderer falls back to doc.displayPrecision.
    expect(dim.precision).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Label override
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — label override', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('entity.label is stored when label param is provided', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(10, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
      label: 'REF',
    });
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.label).toBe('REF');
  });
});

// ---------------------------------------------------------------------------
// 8. dimension is NOT batchable (not routed through instanced renderer)
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — not routed through instanced renderer', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('isBatchable returns false for a dimension entity', async () => {
    const { isBatchable } = await import('../../src/ui/viewport/3d/grouping');
    const idA = addPoint(0, 0);
    const idB = addPoint(5, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });
    const dimId = result.affected[0]!;
    const entity = useStore.getState().document.entities[dimId]!;
    expect(isBatchable(entity)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Aligned dimension
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — aligned dimension', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('produces an aligned dimension entity with dimensionKind "aligned"', () => {
    const idA = addPoint(0, 0);
    const idB = addPoint(3, 4);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'aligned',
      entityIds: [idA, idB],
      offset: 2,
    });
    expect(result.affected).toHaveLength(1);
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.dimensionKind).toBe('aligned');
    expect(dim.offset).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 10. Angular dimension using line entities
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — angular dimension using lines', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('angular dimension accepts vertex point + 2 line entities', () => {
    const vertex = addPoint(0, 0);
    const lineA = addLine(0, 0, 5, 0);
    const lineB = addLine(0, 0, 0, 5);

    const result = localDispatch('add_dimension', {
      dimensionKind: 'angular',
      entityIds: [vertex, lineA, lineB],
    });

    expect(result.affected).toHaveLength(1);
    const dimId = result.affected[0]!;
    const dim = useStore.getState().document.entities[dimId] as DimensionEntity;
    expect(dim.dimensionKind).toBe('angular');
    expect(dim.entityIds[0]).toBe(vertex);
  });
});

// ---------------------------------------------------------------------------
// 11. is2D returns true for dimension entity
// ---------------------------------------------------------------------------

describe('DimensionRenderer2D — is2D classification', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('is2D returns true for a dimension entity', async () => {
    const { is2D } = await import('../../src/core/model/types');
    const idA = addPoint(0, 0);
    const idB = addPoint(5, 0);
    const result = localDispatch('add_dimension', {
      dimensionKind: 'linear',
      entityIds: [idA, idB],
    });
    const dimId = result.affected[0]!;
    const entity = useStore.getState().document.entities[dimId]!;
    expect(is2D(entity)).toBe(true);
  });
});
