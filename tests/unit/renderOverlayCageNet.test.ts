/** render_view `overlay` = "cage" | "net" (04 DIR FR-DIR-40, VC-DIR-31, TECHNICAL_SPEC DES-4c): elements, counts and projection in the SVG. */

import { describe, expect, it } from 'vitest';
import { makeProjector } from '@core/commands/render/camera';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { execute } from '@core/commands/registry';
import { type CadDocument, type SubdivisionEntity, type Vec3, createEmptyDocument } from '@core/model/types';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

interface Data {
  svg: string;
  width: number;
  height: number;
  camera: Parameters<typeof makeProjector>[0];
  orthoHalf: number;
  overlays?: Record<string, { entities: string[]; lines: number; points: number }>;
}
const dataOf = (result: { data?: unknown }): Data => result.data as Data;
const render = (doc: CadDocument, params: object = {}): ReturnType<typeof execute> =>
  execute(doc, 'render_view', { view: 'iso', showAxes: false, showGrid: false, mode: 'vector', ...params } as Record<string, unknown>);

const add = (doc: CadDocument, name: string, params: object): { doc: CadDocument; id: string } => {
  const result = execute(doc, name, params as Record<string, unknown>);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, id: result.affected[0] as string };
};

/** The `<g class="...">` blocks of an overlay layer in `svg`: [entity id, the markup inside]. */
function groups(svg: string, id: 'cage-overlay' | 'net-overlay'): Array<[string, string]> {
  return [...svg.matchAll(new RegExp(`<g class="${id}" data-entity="([^"]*)"[^>]*>([\\s\\S]*?)</g>`, 'g'))].map((m) => [
    m[1] as string,
    m[2] as string,
  ]);
}
const lines = (block: string): Array<[number, number, number, number]> =>
  [...block.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ]);
const dots = (block: string): Array<[number, number]> =>
  [...block.matchAll(/<circle cx="([-\d.]+)" cy="([-\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
const r2 = (n: number): number => Math.round(n * 100) / 100;

const cube = add(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 2 });
const cageOf = (doc: CadDocument, id: string): SubdivisionEntity => doc.entities[id] as SubdivisionEntity;

describe('render_view overlay "cage"', () => {
  it('draws the cage of a subdivision solid: 12 edges once each, 8 vertices, in one group named by the entity', () => {
    const result = render(cube.doc, { overlay: 'cage' });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    const found = groups(data.svg, 'cage-overlay');
    expect(found.map(([id]) => id)).toEqual([cube.id]);
    expect(lines(found[0]?.[1] as string)).toHaveLength(12);
    expect(dots(found[0]?.[1] as string)).toHaveLength(8);
    expect(data.overlays).toEqual({ cage: { entities: [cube.id], lines: 12, points: 8 } });
    expect(result.summary).toContain('Overlay: cage 1 entity');
    expect(data.svg).not.toContain('net-overlay');
  });

  it('projects with the camera of the render: every vertex dot and every edge end is a projected cage vertex', () => {
    const data = dataOf(render(cube.doc, { overlay: 'cage', view: 'top', width: 400, height: 300 }));
    const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
    const expected = cageOf(cube.doc, cube.id).vertices.map((p) => project(p).map(r2) as [number, number]);
    const block = groups(data.svg, 'cage-overlay')[0]?.[1] as string;
    const onScreen = new Set(expected.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of dots(block)) expect(onScreen.has(`${x},${y}`), `dot ${x},${y}`).toBe(true);
    for (const [x1, y1, x2, y2] of lines(block)) {
      expect(onScreen.has(`${x1},${y1}`)).toBe(true);
      expect(onScreen.has(`${x2},${y2}`)).toBe(true);
    }
    // a top view of the cube cage: the four top corners and the four bottom corners coincide on screen in pairs
    expect(onScreen.size).toBeLessThanOrEqual(4 + 4);
    expect(new Set(dots(block).map(([x, y]) => `${x},${y}`)).size).toBeLessThanOrEqual(4 + 4);
  });

  it('follows the entity placement: a moved and rotated cage is drawn where its vertices are in the world', () => {
    const entity = cageOf(cube.doc, cube.id);
    const position: Vec3 = [10, 5, 0];
    const rotation: Vec3 = [0, 0, Math.PI / 6];
    const placedDoc: CadDocument = { ...cube.doc, entities: { ...cube.doc.entities, [cube.id]: { ...entity, position, rotation } } };
    const data = dataOf(render(placedDoc, { overlay: 'cage' }));
    const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
    const world = entity.vertices.map((p) =>
      applyEulerXYZ([p[0] + position[0], p[1] + position[1], p[2] + position[2]], position, rotation),
    );
    const expected = new Set(world.map((p) => project(p).map(r2).join(',')));
    const block = groups(data.svg, 'cage-overlay')[0]?.[1] as string;
    expect(dots(block)).toHaveLength(8);
    for (const [x, y] of dots(block)) expect(expected.has(`${x},${y}`), `dot ${x},${y}`).toBe(true);
    // and it is not where the unmoved cage would be
    const unmoved = new Set(entity.vertices.map((p) => project(p).map(r2).join(',')));
    expect(dots(block).some(([x, y]) => unmoved.has(`${x},${y}`))).toBe(false);
  });

  it('is placed like the rendered mesh: the centre of the dots is the projected centre of the own world bounds of the render (an oracle that does not share the placement rule)', () => {
    const entity = cageOf(cube.doc, cube.id);
    for (const [position, rotation] of [
      [
        [10, 5, 0],
        [0, 0, Math.PI / 6],
      ],
      [
        [-4, 2, 3],
        [0.3, 0, 0.5],
      ],
    ] as Array<[Vec3, Vec3]>) {
      const placedDoc: CadDocument = { ...cube.doc, entities: { ...cube.doc.entities, [cube.id]: { ...entity, position, rotation } } };
      const data = dataOf(render(placedDoc, { overlay: 'cage' }));
      const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
      const bounds = (data as unknown as { bounds: { min: Vec3; max: Vec3 } }).bounds;
      const middle = project(bounds.min.map((lo, k) => (lo + (bounds.max[k] as number)) / 2) as unknown as Vec3);
      const points = dots(groups(data.svg, 'cage-overlay')[0]?.[1] as string);
      const mean = [0, 1].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / points.length);
      expect(Math.hypot((mean[0] as number) - (middle[0] as number), (mean[1] as number) - (middle[1] as number))).toBeLessThan(3);
    }
  });

  it('two entities: one group each with distinct classes of a layer shared and no duplicate element ids; the order is the document order; a turntable says it draws no overlay', () => {
    const second = add(cube.doc, 'add_subdivision_solid', { box: { size: [1, 1, 1] }, levels: 1, position: [5, 0, 0] });
    const data = dataOf(render(second.doc, { overlay: 'cage' }));
    expect(groups(data.svg, 'cage-overlay').map(([id]) => id)).toEqual([cube.id, second.id]);
    const ids = [...data.svg.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const reordered: CadDocument = { ...second.doc, order: [second.id, cube.id] };
    expect(groups(dataOf(render(reordered, { overlay: 'cage' })).svg, 'cage-overlay').map(([id]) => id)).toEqual([second.id, cube.id]);
    const strip = render(cube.doc, { overlay: 'cage', turntable: { frames: 2 } });
    expect(strip.summary).toContain('Overlay not drawn on a turntable strip');
    expect(dataOf(strip).svg).not.toContain('cage-overlay');
  });
});

describe('render_view overlay "net"', () => {
  const surface = add(createEmptyDocument(), 'create_nurbs_surface', {
    degreeU: 2,
    degreeV: 2,
    poles: [0, 1, 2, 3].map((i) => [0, 1, 2].map((j): Vec3 => [i * 2, j * 2, (i + j) % 2])),
  });
  const withCurve = add(surface.doc, 'create_nurbs_curve', { degree: 3, poles: [0, 1, 2, 3, 4].map((i): Vec3 => [i * 2, -3, i % 2]) });

  it('draws the control net of a surface (rows and columns: 4 x 2 + 3 x 3 = 17 segments, 12 poles) and the control polygon of a curve (4 segments, 5 poles)', () => {
    const result = render(withCurve.doc, { overlay: 'net' });
    expect(result.error, result.summary).toBeUndefined();
    const data = dataOf(result);
    const found = groups(data.svg, 'net-overlay');
    expect(found.map(([id]) => id)).toEqual([surface.id, withCurve.id]);
    expect(lines(found[0]?.[1] as string)).toHaveLength(17);
    expect(dots(found[0]?.[1] as string)).toHaveLength(12);
    expect(lines(found[1]?.[1] as string)).toHaveLength(4);
    expect(dots(found[1]?.[1] as string)).toHaveLength(5);
    expect(data.overlays).toEqual({ net: { entities: [surface.id, withCurve.id], lines: 21, points: 17 } });
    expect(data.svg).not.toContain('cage-overlay');
  });

  it('projects the poles with the camera of the render', () => {
    const data = dataOf(render(surface.doc, { overlay: 'net', view: 'front' }));
    const project = makeProjector(data.camera, data.orthoHalf, data.width, data.height);
    const poles = (surface.doc.entities[surface.id] as unknown as { surface: { poles: Vec3[][] } }).surface.poles.flat();
    const expected = new Set(poles.map((p) => project(p).map(r2).join(',')));
    for (const [x, y] of dots(groups(data.svg, 'net-overlay')[0]?.[1] as string)) expect(expected.has(`${x},${y}`)).toBe(true);
  });
});

describe('render_view overlay: combinations and limits', () => {
  const both = add(cube.doc, 'create_nurbs_surface', {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [
        [0, 0, 0],
        [0, 4, 0],
      ],
      [
        [4, 0, 0],
        [4, 4, 0],
      ],
    ],
  });

  it('draws both kinds from an array, the cage first; draws nothing without `overlay`', () => {
    const data = dataOf(render(both.doc, { overlay: ['net', 'cage'] }));
    expect(groups(data.svg, 'cage-overlay')).toHaveLength(1);
    expect(groups(data.svg, 'net-overlay')).toHaveLength(1);
    expect(data.svg.indexOf('cage overlay')).toBeLessThan(data.svg.indexOf('net overlay'));
    expect(Object.keys(data.overlays ?? {}).sort()).toEqual(['cage', 'net']);
    const plain = dataOf(render(both.doc));
    expect(plain.svg).not.toContain('-overlay');
    expect(plain.overlays).toBeUndefined();
  });

  it('with isolate only the isolated entities get an overlay', () => {
    const data = dataOf(render(both.doc, { overlay: ['cage', 'net'], isolate: both.id }));
    expect(groups(data.svg, 'cage-overlay')).toHaveLength(0);
    expect(groups(data.svg, 'net-overlay').map(([id]) => id)).toEqual([both.id]);
    expect(data.overlays).toMatchObject({ cage: { entities: [], lines: 0, points: 0 }, net: { entities: [both.id] } });
  });

  it('a document without a cage or a net draws no group and says so; perspective draws no overlay and says so; bad values are refused', () => {
    const boxOnly = add(createEmptyDocument(), 'add_box', { size: [1, 1, 1] });
    const empty = render(boxOnly.doc, { overlay: 'cage' });
    expect(groups(dataOf(empty).svg, 'cage-overlay')).toHaveLength(0);
    expect(dataOf(empty).overlays).toEqual({ cage: { entities: [], lines: 0, points: 0 } });
    expect(empty.summary).toContain('cage 0 entities');
    const perspective = render(cube.doc, { overlay: 'cage', projection: 'perspective', mode: 'raster' });
    expect(perspective.error, perspective.summary).toBeUndefined();
    expect(perspective.summary).toContain('not drawn: it needs an orthographic view');
    expect(dataOf(perspective).svg).not.toContain('cage-overlay');
    const bad = execute(cube.doc, 'render_view', { overlay: 'wires' });
    expectNoOp(bad, cube.doc);
    expect(bad.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(execute(cube.doc, 'render_view', { overlay: [] }).error?.code).toBe('CMD_INVALID_PARAMS');
  });

  it('is read-only and pure', () => {
    expectPure(cube.doc, () => render(cube.doc, { overlay: ['cage', 'net'] }));
    expect(render(cube.doc, { overlay: 'cage' }).document).toBe(cube.doc);
    expect(render(cube.doc, { overlay: 'cage' }).affected).toEqual([]);
  });
});
