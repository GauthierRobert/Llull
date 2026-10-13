import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CadDocument, type Entity, type Vec2, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import type { DrawingPrimitive } from '@core/model/drawing';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { add } from '../helpers/addEntity';
import { solidDrawing } from '../../src/ui/viewport/2d/solidDrawing';
import {
  drawingChains,
  drawingSegments,
  segmentsDistSq,
} from '../../src/ui/viewport/2d/solidDrawingEdges';
import { drawingSnapPoints } from '../../src/ui/viewport/2d/solidDrawingSnaps';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import { entitiesInBox } from '../../src/ui/viewport/2d/boxSelect';
import { nearestEntityId } from '../../src/ui/viewport/2d/modifyHelpers';

const entityOf = (doc: CadDocument, id: string): Entity => doc.entities[id] as Entity;
const snapsOf = (doc: CadDocument, id: string): ReturnType<typeof drawingSnapPoints> =>
  drawingSnapPoints(solidDrawing(doc, entityOf(doc, id)));
const has = (
  snaps: ReturnType<typeof drawingSnapPoints>,
  type: string,
  x: number,
  y: number,
): boolean => snaps.some((s) => s.type === type && Math.hypot(s.x - x, s.y - y) < 1e-3);
const line = (a: Vec2, b: Vec2, style: 'visible' | 'center' = 'visible'): DrawingPrimitive => ({
  type: 'line',
  layer: 'L',
  style,
  a,
  b,
});

describe('solidDrawing', () => {
  it('is the top-view technical drawing of the solid alone, memoized per entity', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', { size: [4, 2, 1] });
    const first = solidDrawing(doc, entityOf(doc, id));
    expect(first.some((p) => p.style === 'visible')).toBe(true);
    expect(solidDrawing(doc, entityOf(doc, id))).toBe(first);
  });

  it('is empty for 2D shapes and derived bim geometry', () => {
    const arc = add(createEmptyDocument(), 'draw_arc', { center: [0, 0], radius: 1 });
    expect(solidDrawing(arc.doc, entityOf(arc.doc, arc.id))).toEqual([]);
    const box = add(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const tagged = { ...entityOf(box.doc, box.id), tags: ['bim'] } as Entity;
    expect(solidDrawing(box.doc, tagged)).toEqual([]);
  });

  it('re-expands an instance when its component changes', () => {
    const box = add(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const comp = add(box.doc, 'create_component', { name: 'C', entityIds: [box.id] });
    const instance = entityOf(comp.doc, comp.id);
    const before = solidDrawing(comp.doc, instance);
    expect(before.length).toBeGreaterThan(0);
    const emptied = { ...comp.doc, components: {} };
    expect(solidDrawing(emptied, instance)).toEqual([]);
  });
});

describe('drawing edges', () => {
  it('measures distance to segments and ignores centre lines', () => {
    const primitives = [line([0, 0], [4, 0]), line([0, 0], [0, 9], 'center')];
    const segments = drawingSegments(primitives);
    expect(segments).toHaveLength(1);
    expect(segmentsDistSq(segments, [5, 1])).toBeCloseTo(2);
    expect(segmentsDistSq([], [0, 0])).toBe(Infinity);
  });

  it('chains segments through degree-2 vertices only', () => {
    const chains = drawingChains([
      line([0, 0], [1, 0]),
      line([2, 0], [1, 0]),
      line([2, 0], [2, 1]),
      line([2, 1], [0, 0]),
      line([5, 5], [6, 5]),
      line([5, 5], [5, 6]),
      line([5, 5], [4, 5]),
    ]);
    expect(chains.filter((c) => c.closed)).toHaveLength(1);
    expect(chains.find((c) => c.closed)?.points).toHaveLength(4);
    expect(chains.filter((c) => !c.closed)).toHaveLength(3);
  });

  it('turns a polygon primitive into a closed ring', () => {
    const [chain] = drawingChains([
      {
        type: 'polygon',
        layer: 'L',
        style: 'cut',
        points: [
          [0, 0],
          [2, 0],
          [2, 2],
        ],
      },
    ]);
    expect(chain?.closed).toBe(true);
    expect(chain?.points).toHaveLength(3);
  });
});

describe('drawing snap points', () => {
  it('gives a box its 4 corners, 4 edge midpoints and centre-less outline', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', { size: [4, 2, 1] });
    const snaps = snapsOf(doc, id);
    expect(snaps.filter((s) => s.type === 'endpoint')).toHaveLength(4);
    expect(snaps.filter((s) => s.type === 'midpoint')).toHaveLength(4);
    expect(snaps.some((s) => s.type === 'center')).toBe(false);
    const e = entityOf(doc, id);
    const [px, py] = [e.position[0], e.position[1]];
    expect(has(snaps, 'endpoint', px - 2, py - 1)).toBe(true);
    expect(has(snaps, 'midpoint', px, py - 1)).toBe(true);
  });

  it('gives a cylinder its centre and exactly four quadrants, not one snap per chord', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', {
      radius: 3,
      height: 2,
      position: [10, 5, 0],
    });
    const snaps = snapsOf(doc, id);
    expect(has(snaps, 'center', 10, 5)).toBe(true);
    const quadrants = snaps.filter((s) => s.type === 'endpoint');
    expect(quadrants).toHaveLength(4);
    expect(has(snaps, 'endpoint', 13, 5)).toBe(true);
    expect(has(snaps, 'endpoint', 7, 5)).toBe(true);
    expect(has(snaps, 'endpoint', 10, 8)).toBe(true);
    expect(has(snaps, 'endpoint', 10, 2)).toBe(true);
    expect(snaps.some((s) => s.type === 'midpoint')).toBe(false);
  });

  it('follows a tilted solid and snaps to its drawn corners', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_box', {
      size: [2, 2, 2],
      rotation: [0, 0, Math.PI / 4],
    });
    const snaps = snapsOf(doc, id);
    const r = Math.SQRT2;
    const e = entityOf(doc, id);
    expect(has(snaps, 'endpoint', e.position[0] + r, e.position[1])).toBe(true);
    expect(has(snaps, 'endpoint', e.position[0], e.position[1] - r)).toBe(true);
    const tilted = add(createEmptyDocument(), 'add_box', {
      size: [2, 2, 2],
      rotation: [Math.PI / 4, 0, 0],
    });
    expect(
      snapsOf(tilted.doc, tilted.id).filter((s) => s.type === 'endpoint').length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('gives crossing centre lines a centre snap but a lone axis line none', () => {
    const cross = drawingSnapPoints([
      line([-2, 1], [2, 1], 'center'),
      line([0, -1], [0, 3], 'center'),
    ]);
    expect(cross).toEqual([{ x: 0, y: 1, type: 'center' }]);
    expect(drawingSnapPoints([line([0, 0], [4, 0], 'center')])).toEqual([]);
    expect(
      drawingSnapPoints([line([-2, 1], [2, 1], 'center'), line([0, 2], [0, 6], 'center')]),
    ).toEqual([]);
  });

  it('is empty for empty geometry', () => {
    expect(drawingSnapPoints([])).toEqual([]);
    expect(drawingSegments([])).toEqual([]);
  });
});

describe('boolean plate with a hole (Manifold kernel)', () => {
  let previous: GeometryKernel | null;
  beforeAll(async () => {
    previous = getGeometryKernel();
    setGeometryKernel(await createManifoldKernel());
  }, 60_000);
  afterAll(() => setGeometryKernel(previous));

  it('snaps to the hole centre and quadrants and picks the hole edge', () => {
    let doc = createEmptyDocument();
    const plate = add(doc, 'add_box', { size: [10, 10, 2], position: [0, 0, 0] });
    const tool = add(plate.doc, 'add_cylinder', { radius: 1, height: 6, position: [2, 1, 0] });
    doc = execute(tool.doc, 'boolean', { op: 'subtract', a: plate.id, b: tool.id }).document;
    const solidId = doc.order[0] as string;
    const snaps = snapsOf(doc, solidId);
    expect(has(snaps, 'center', 2, 1)).toBe(true);
    expect(has(snaps, 'endpoint', 3, 1)).toBe(true);
    expect(has(snaps, 'endpoint', 2, 2)).toBe(true);
    expect(collectSnapCandidates(doc).some((s) => s.type === 'center')).toBe(true);
    expect(nearestEntityId(doc, [3.02, 1], 0.2)).toBe(solidId);
  });
});

describe('2D interaction derived from the drawing', () => {
  it('collectSnapCandidates respects the endpoint/midpoint/centre switches', () => {
    const { doc } = add(createEmptyDocument(), 'add_box', { size: [4, 2, 1] });
    expect(collectSnapCandidates(doc).filter((s) => s.type === 'endpoint')).toHaveLength(4);
    const none = collectSnapCandidates(doc, { endpoints: false, midpoints: false, centers: false });
    expect(none.filter((s) => s.type !== 'perpendicular' && s.type !== 'tangent')).toHaveLength(0);
  });

  it('picks a cylinder outline but not its interior', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', { radius: 3, height: 2 });
    expect(nearestEntityId(doc, [3.05, 0], 0.2)).toBe(id);
    expect(nearestEntityId(doc, [0, 0], 0.2)).toBeNull();
  });

  it('box-selects by window (whole drawing inside) and crossing (touching)', () => {
    const { doc, id } = add(createEmptyDocument(), 'add_cylinder', { radius: 3, height: 2 });
    expect(entitiesInBox(doc, [-4, -4], [4, 4])).toEqual([id]);
    expect(entitiesInBox(doc, [-4, -4], [0, 0])).toEqual([]);
    expect(entitiesInBox(doc, [4, 4], [0, 0])).toEqual([id]);
    // The centre-line overshoot (radius * 1.25) must not count: a window just past the outline works.
    expect(entitiesInBox(doc, [-3.1, -3.1], [3.1, 3.1])).toEqual([id]);
  });
});
