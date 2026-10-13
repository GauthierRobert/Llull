import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CadDocument,
  type Entity,
  type ShapeRecipe,
  createEmptyDocument,
} from '@core/model/types';
import type { DrawingPrimitive } from '@core/model/drawing';
import { setGeometryKernel } from '@core/geometry/kernel';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import { TECHNICAL_LAYERS, technicalView } from '@core/geometry/technicalView';
import { centerLinePrimitives } from '@core/geometry/centerLines';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { add } from '../helpers/addEntity';

const solidsOf = (doc: CadDocument): Entity[] => doc.order.map((id) => doc.entities[id] as Entity);

const ofStyle = (primitives: ReadonlyArray<DrawingPrimitive>, style: string): DrawingPrimitive[] =>
  primitives.filter((p) => p.style === style);

const lineLength = (p: DrawingPrimitive): number =>
  p.type === 'line' ? Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) : 0;

const totalLength = (primitives: ReadonlyArray<DrawingPrimitive>): number =>
  primitives.reduce((sum, p) => sum + lineLength(p), 0);

describe('technicalView — top view of solids', () => {
  it('draws a box as thick visible edges only, on the OBJ layers', () => {
    const { doc } = add(createEmptyDocument(), 'add_box', { size: [4, 2, 1], position: [0, 0, 0] });
    const [drawing] = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW });
    const visible = ofStyle(drawing?.primitives ?? [], 'visible');
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((p) => p.layer === TECHNICAL_LAYERS.visible)).toBe(true);
    // The top outline (perimeter 12) is visible; the coincident bottom edges add no hidden line.
    expect(totalLength(visible)).toBeGreaterThanOrEqual(12 - 1e-6);
    expect(ofStyle(drawing?.primitives ?? [], 'hidden')).toHaveLength(0);
    expect(ofStyle(drawing?.primitives ?? [], 'center')).toHaveLength(0);
  });

  it('dashes the edges another solid covers (hidden lines across solids)', () => {
    let doc = add(createEmptyDocument(), 'add_box', { size: [10, 10, 1], position: [0, 0, 5] }).doc;
    const small = add(doc, 'add_box', { size: [2, 2, 1], position: [0, 0, 0] });
    doc = small.doc;
    const drawings = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW });
    const under = drawings.find((d) => d.entityId === small.id);
    expect(ofStyle(under?.primitives ?? [], 'visible')).toHaveLength(0);
    expect(totalLength(ofStyle(under?.primitives ?? [], 'hidden'))).toBeGreaterThanOrEqual(
      8 - 1e-6,
    );
  });

  it('hides an edge lying on the tessellation seams of the face above it', () => {
    let doc = add(createEmptyDocument(), 'add_cylinder', {
      radius: 10,
      height: 2,
      position: [0, 0, 5],
    }).doc;
    // The box's edge x = 0 runs exactly along the cylinder cap's triangle borders.
    const box = add(doc, 'add_box', { size: [10, 40, 1], position: [-5, 0, 0] });
    doc = box.doc;
    const drawing = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW }).find(
      (d) => d.entityId === box.id,
    );
    const hiddenOnSeam = ofStyle(drawing?.primitives ?? [], 'hidden').filter(
      (p) => p.type === 'line' && Math.abs(p.a[0]) < 1e-9 && Math.abs(p.b[0]) < 1e-9,
    );
    // Top and bottom box edges coincide in plan: drawn once, 20 long inside the circle.
    expect(totalLength(hiddenOnSeam)).toBeCloseTo(20, 0);
  });

  it('splits an edge that is partly covered into visible and hidden runs', () => {
    let doc = add(createEmptyDocument(), 'add_box', { size: [4, 4, 1], position: [2, 0, 5] }).doc;
    const long = add(doc, 'add_box', { size: [8, 1, 1], position: [0, 0, 0] });
    doc = long.doc;
    const drawing = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW }).find(
      (d) => d.entityId === long.id,
    );
    const visible = totalLength(ofStyle(drawing?.primitives ?? [], 'visible'));
    const hidden = totalLength(ofStyle(drawing?.primitives ?? [], 'hidden'));
    // Long edges: x in [-4, 4]; the cover spans x in [0, 4] -> half of each long edge is hidden.
    expect(hidden).toBeGreaterThan(7.9);
    expect(visible).toBeGreaterThan(7.9);
  });

  it('marks an upright cylinder with a centre cross and a side-on one with its axis', () => {
    let doc = add(createEmptyDocument(), 'add_cylinder', {
      radius: 2,
      height: 4,
      position: [10, 5, 0],
    }).doc;
    const lying = add(doc, 'add_cylinder', {
      radius: 1,
      height: 6,
      position: [0, 20, 0],
      rotation: [Math.PI / 2, 0, 0],
    });
    doc = lying.doc;
    const drawings = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW });
    const upright = ofStyle(drawings[0]?.primitives ?? [], 'center');
    expect(upright).toHaveLength(2);
    expect(upright.every((p) => p.layer === TECHNICAL_LAYERS.center)).toBe(true);
    expect(lineLength(upright[0] as DrawingPrimitive)).toBeCloseTo(2 * 2 * 1.25);
    const axis = ofStyle(drawings[1]?.primitives ?? [], 'center');
    expect(axis).toHaveLength(1);
    expect(lineLength(axis[0] as DrawingPrimitive)).toBeCloseTo(6 + 2 * 0.25);
  });

  it('cuts a section: hatched cut face, no hidden lines, nothing in front of the plane', () => {
    const { doc } = add(createEmptyDocument(), 'add_box', { size: [4, 4, 4], position: [0, 0, 0] });
    const [drawing] = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW, cutDepth: 0 });
    const cut = drawing?.primitives.find((p) => p.type === 'polygon' && p.fill === 'hatch');
    expect(cut?.style).toBe('cut');
    expect(cut?.layer).toBe(TECHNICAL_LAYERS.cut);
    expect(ofStyle(drawing?.primitives ?? [], 'hidden')).toHaveLength(0);
    // Edges below the cut are under the cut face: nothing else is visible.
    expect(ofStyle(drawing?.primitives ?? [], 'visible')).toHaveLength(0);
  });

  it('outlines the holes of a cut face without filling them', () => {
    const { doc } = add(createEmptyDocument(), 'revolve_profile', {
      profile: [
        [2, 0],
        [3, 0],
        [3, 4],
        [2, 4],
      ],
      axis: [0, 0, 1],
      position: [0, 0, 0],
    });
    const [drawing] = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW, cutDepth: 2 });
    const hatched = drawing?.primitives.filter((p) => p.type === 'polygon');
    expect(hatched).toHaveLength(1);
    expect(hatched?.[0]?.type === 'polygon' && hatched[0].holes).toHaveLength(1);
    const outline = drawing?.primitives.find((p) => p.type === 'polyline');
    expect(outline?.style).toBe('cut');
  });

  it('skips 2D shapes and a section plane above everything leaves the plain view', () => {
    let doc = add(createEmptyDocument(), 'draw_line', { start: [0, 0], end: [1, 1] }).doc;
    doc = add(doc, 'add_sphere', { radius: 1, position: [0, 0, 0] }).doc;
    const drawings = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW, cutDepth: 100 });
    expect(drawings).toHaveLength(1);
    expect(ofStyle(drawings[0]?.primitives ?? [], 'center')).toHaveLength(2);
    expect(drawings[0]?.primitives.some((p) => p.style === 'cut')).toBe(false);
  });

  it('draws a centre mark on every component child of an instance', () => {
    let doc = add(createEmptyDocument(), 'add_cylinder', {
      radius: 1,
      height: 1,
      position: [0, 0, 0],
    });
    const comp = add(doc.doc, 'create_component', { name: 'Peg', entityIds: [doc.id] });
    doc = comp;
    const drawings = technicalView(doc.doc, solidsOf(doc.doc), { frame: TOP_VIEW });
    expect(ofStyle(drawings[0]?.primitives ?? [], 'center')).toHaveLength(2);
  });
});

describe('technicalView — boolean parts (Manifold kernel)', () => {
  beforeAll(async () => {
    setGeometryKernel(await createManifoldKernel());
  });

  it('gives a flange its bolt-hole centre marks and their pitch circle (PCD)', () => {
    let doc = add(createEmptyDocument(), 'add_cylinder', {
      radius: 10,
      height: 2,
      position: [0, 0, 0],
    }).doc;
    let body = doc.order[0] as string;
    for (let k = 0; k < 6; k++) {
      const angle = (k * Math.PI) / 3;
      const hole = add(doc, 'add_cylinder', {
        radius: 1,
        height: 4,
        position: [7 * Math.cos(angle), 7 * Math.sin(angle), 0],
      });
      const cut = add(hole.doc, 'boolean', { op: 'subtract', a: body, b: hole.id });
      doc = cut.doc;
      body = cut.id;
    }
    const [drawing] = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW });
    const centre = ofStyle(drawing?.primitives ?? [], 'center');
    const pcd = centre.find((p) => p.type === 'circle');
    expect(pcd?.type === 'circle' && pcd.radius).toBeCloseTo(7);
    // 1 body cross + 6 hole crosses, two lines each.
    expect(centre.filter((p) => p.type === 'line')).toHaveLength(14);
    expect(ofStyle(drawing?.primitives ?? [], 'visible').length).toBeGreaterThan(6 * 8);
  });
});

describe('centerLinePrimitives — round features of B-rep recipes', () => {
  const entityOf = (name: string, params: unknown): Entity => {
    const { doc, id } = add(createEmptyDocument(), name, params);
    return doc.entities[id] as Entity;
  };
  /** A mesh result spanning [-10, 10]³ whose B-rep recipe is `brep`. */
  const meshWith = (brep: ShapeRecipe): Entity => {
    const corners = [-10, 10].flatMap((x) =>
      [-10, 10].flatMap((y) => [-10, 10].flatMap((z) => [x, y, z])),
    );
    const box = entityOf('add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    return { ...box, kind: 'mesh', mesh: { positions: corners, indices: [] }, brep } as Entity;
  };
  const centreOf = (entity: Entity): DrawingPrimitive[] =>
    centerLinePrimitives(entity, { components: {} }, TOP_VIEW, 'C');

  it('walks booleans, fillets, shells, blends, placements and scales to the holes', () => {
    const plate = entityOf('add_box', { size: [10, 10, 2], position: [0, 0, 0] });
    const hole = entityOf('add_cylinder', { radius: 1, height: 4, position: [0, 0, 0] });
    const cut: ShapeRecipe = {
      op: 'boolean',
      boolean: 'subtract',
      a: { op: 'solid', entity: plate },
      b: { op: 'solid', entity: hole },
    };
    const tree: ShapeRecipe = {
      op: 'place',
      position: [3, 0, 0],
      rotation: [0, 0, 0],
      source: {
        op: 'scale',
        factor: 2,
        source: {
          op: 'blend',
          radius: 0.1,
          sources: [
            {
              op: 'shell',
              thickness: 0.1,
              source: { op: 'fillet', edges: [], size: 0.1, source: cut },
            },
          ],
        },
      },
    };
    const lines = centreOf(meshWith(tree)).filter((p) => p.type === 'line');
    expect(lines).toHaveLength(2);
    const horizontal = lines.find((p) => p.type === 'line' && p.a[1] === p.b[1]);
    // Hole radius 1 scaled ×2, cross reach 1.25 r; centred at the placed origin x = 3.
    expect(horizontal?.type === 'line' && (horizontal.a[0] + horizontal.b[0]) / 2).toBeCloseTo(3);
    expect(horizontal && lineLength(horizontal)).toBeCloseTo(2 * 2 * 1.25);
  });

  it('drops a tool cylinder that lies outside the part and draws no PCD for a rectangle', () => {
    const far = entityOf('add_cylinder', { radius: 1, height: 2, position: [50, 0, 0] });
    expect(centreOf(meshWith({ op: 'solid', entity: far }))).toHaveLength(0);
    const corners: ShapeRecipe[] = [
      [-6, -3],
      [6, -3],
      [6, 3],
      [-6, 3],
    ].map(([x, y]) => ({
      op: 'solid',
      entity: entityOf('add_cylinder', { radius: 1, height: 2, position: [x, y, 0] }),
    }));
    const union = corners.reduce(
      (a, b): ShapeRecipe => ({ op: 'boolean', boolean: 'union', a, b }),
    );
    const primitives = centreOf(meshWith(union));
    expect(primitives.filter((p) => p.type === 'line')).toHaveLength(8);
    expect(primitives.some((p) => p.type === 'circle')).toBe(false);
  });

  it('marks cones, tori and spheres, and follows the axis a revolution really spins about', () => {
    expect(
      centreOf(entityOf('add_cone', { radius: 2, height: 3, position: [0, 0, 0] })),
    ).toHaveLength(2);
    expect(
      centreOf(entityOf('add_torus', { ringRadius: 4, tubeRadius: 1, position: [0, 0, 0] })),
    ).toHaveLength(2);
    // Axis −X: the mesh spins about +X (dominant axis, sign ignored); axial span 0..4.
    const lying = entityOf('revolve_profile', {
      profile: [
        [1, 0],
        [2, 0],
        [2, 4],
        [1, 4],
      ],
      axis: [-1, 0, 0],
      position: [0, 0, 0],
    });
    const [axis] = centreOf(lying);
    expect(
      axis?.type === 'line' && [Math.min(axis.a[0], axis.b[0]), Math.max(axis.a[0], axis.b[0])],
    ).toEqual([expect.closeTo(-0.5), expect.closeTo(4.5)]);
  });
});

describe('technicalView — centre lines under a section', () => {
  it('drops the centre lines of features cut away in front of the plane', () => {
    let doc = add(createEmptyDocument(), 'add_cylinder', {
      radius: 1,
      height: 2,
      position: [0, 0, 0],
      rotation: [Math.PI / 2, 0, 0],
    }).doc;
    doc = add(doc, 'add_cylinder', { radius: 1, height: 2, position: [5, 0, -10] }).doc;
    // Looking down, cut at z = -5: the lying cylinder (z = 0) is removed, the upright one stays.
    const drawings = technicalView(doc, solidsOf(doc), { frame: TOP_VIEW, cutDepth: -5 });
    const centre = drawings.flatMap((d) => d.primitives).filter((p) => p.style === 'center');
    expect(centre).toHaveLength(2);
    expect(
      centre.every((p) => p.type === 'line' && Math.abs((p.a[0] + p.b[0]) / 2 - 5) < 1e-9),
    ).toBe(true);
  });
});
