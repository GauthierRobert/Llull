/** Code export and centre lines of feature results (07 FTR §6): holes lower to a revolved cut plus the CadQuery idiom as a note. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { centerLinePrimitives } from '@core/geometry/centerLines';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import type { ShapeTopology } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type Entity, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { TETRA } from '../../helpers/fakeKernel';
import { ctxWith, idOf, manifoldSuite, meshOf, plate } from '../../helpers/featureSupport';

manifoldSuite();

interface Code {
  text: string;
  notes: string[];
}
const codeOf = (doc: CadDocument, language: string): Code => execute(doc, 'export_code', { language }).data as Code;

function drilledPlate(): { doc: CadDocument; id: string } {
  const stock = plate();
  const top = { near: [50, 30, 10] };
  const csk = execute(stock.doc, 'add_hole', {
    target: stock.id,
    face: top,
    points: [
      [10, 10],
      [90, 10],
    ],
    hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100, thread: { designation: 'M5x0.8-6H' } },
    extent: { kind: 'through_all' },
  });
  const blind = execute(csk.document, 'add_hole', {
    target: idOf(csk),
    face: top,
    points: [[50, 15]],
    hole: { kind: 'simple', diameter: 6 },
    extent: { kind: 'blind', depth: 6, drillPointAngle: 118 },
  });
  const cbore = execute(blind.document, 'add_hole', {
    target: idOf(blind),
    face: top,
    points: [[30, 30]],
    hole: { kind: 'counterbore', diameter: 5.5, cboreDiameter: 10, cboreDepth: 5.5 },
    extent: { kind: 'through_all' },
  });
  const pocket = execute(cbore.document, 'add_pocket', {
    target: idOf(cbore),
    face: top,
    outline: { kind: 'rectangle', center: [50, 45], size: [40, 12] },
    depth: 4,
    cornerRadius: 3,
    floorFillet: 0,
  });
  return { doc: pocket.document, id: idOf(pocket) };
}

describe('export_code of drilled and pocketed parts', () => {
  it.each(['cadquery', 'build123d', 'freecad', 'openscad'])('%s: the revolved cut is executable and the idiom is a comment', (language) => {
    const { doc } = drilledPlate();
    const { text } = codeOf(doc, language);
    expect(text).toContain('.cskHole(4.8, 9, 100)');
    expect(text).toContain('.cboreHole(5.5, 10, 5.5)');
    expect(text).toContain('.hole(6, 6)');
    expect(text).toContain('drill point 118 deg');
    expect(text).toContain('thread M5x0.8-6H (cosmetic, no geometry)');
    expect(text).toContain('add_pocket');
    const comment = language === 'openscad' ? '// ' : '# ';
    expect(text).toContain(`${comment}add_hole:`);
  });

  it('cadquery and freecad cut the revolved tools with boolean helpers; no raw designation text escapes into code', () => {
    const { doc } = drilledPlate();
    expect(codeOf(doc, 'cadquery').text).toMatch(/= cut\(/);
    expect(codeOf(doc, 'cadquery').text).toMatch(/revolve\(/);
    expect(codeOf(doc, 'freecad').text).toMatch(/\.cut\(/);
    expect(codeOf(doc, 'openscad').text).toContain('difference()');
  });

  it('a loaded designation with control characters cannot break out of the comment', () => {
    const stock = plate();
    const drilled = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4, thread: { designation: 'Rc 1/4 taper', family: 'other' } },
      extent: { kind: 'through_all' },
    });
    const refused = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 30, 10] },
      points: [[10, 10]],
      hole: { kind: 'simple', diameter: 4, thread: { designation: 'Rc 1/4\nimport os', family: 'other' } },
      extent: { kind: 'through_all' },
    });
    expect(refused.error?.code).toBe('FTR_THREAD_DESIGNATION_INVALID');
    const id = idOf(drilled);
    const tampered = JSON.parse(JSON.stringify(drilled.document).replace('Rc 1/4 taper', 'Rc 1/4\\nimport os')) as CadDocument;
    const text = codeOf(tampered, 'cadquery').text;
    expect(tampered.entities[id]).toBeDefined();
    expect(text).not.toMatch(/^import os/m);
    expect(text).toContain('# thread Rc 1/4 import os');
  });
});

describe('a pocket with a floor fillet in code', () => {
  /** A kernel with a canned B-rep topology: the floor perimeter of a 20 x 10 pocket 3 deep in a block whose top is z = 10. */
  const floorKernel = (): ReturnType<typeof kernelFromOps<object>> => {
    const line = (index: number, start: [number, number, number], end: [number, number, number]): ShapeTopology['edges'][number] => ({
      index,
      curve: 'line',
      length: 1,
      start,
      end,
      mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      seam: false,
      degenerate: false,
    });
    const topology: ShapeTopology = {
      solids: 1,
      vertices: 0,
      volume: 1,
      faces: [],
      edges: [
        line(0, [0, 0, 7], [20, 0, 7]),
        line(1, [20, 0, 7], [20, 10, 7]),
        line(2, [20, 10, 7], [0, 10, 7]),
        line(3, [0, 10, 7], [0, 0, 7]),
      ],
    };
    return kernelFromOps<object>({
      name: 'canned',
      solid: () => ({}),
      boolean: () => ({}),
      fillet: () => ({}),
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: () => ({}),
      scale: () => ({}),
      tessellate: () => TETRA,
      topology: () => topology,
      exportStep: () => null,
      release: () => undefined,
    });
  };

  const filletedPocket = (floorFillet: number): CadDocument => {
    const stock = plate();
    const recipe: ShapeRecipe = {
      op: 'feature',
      source: { op: 'solid', entity: stock.doc.entities[stock.id] as Entity },
      feature: 'pocket',
      frame: { origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0] },
      pocket: {
        outline: [
          [0, 0],
          [20, 0],
          [20, 10],
          [0, 10],
        ],
        depth: 3,
        cornerRadius: 0,
        floorFillet,
      },
    };
    const part: MeshSolidEntity = {
      id: 'mesh-9',
      kind: 'mesh',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#888888',
      mesh: TETRA,
      brep: recipe,
    };
    return { ...stock.doc, entities: { ...stock.doc.entities, [part.id]: part }, order: [part.id] };
  };

  it('is cut and then filleted on the floor edges', () => {
    const doc = filletedPocket(1);
    const result = execute(doc, 'export_code', { language: 'cadquery' }, ctxWith(floorKernel()));
    const text = (result.data as Code).text;
    expect(text).toMatch(/fillet\([a-z_0-9]+, \[0, 1, 2, 3\], 1, near=\[/);
  });

  it('falls back to triangles when the floor edges cannot be found', () => {
    const doc = filletedPocket(1);
    const noTopology = kernelFromOps<object>({
      name: 'blank',
      solid: () => ({}),
      boolean: () => ({}),
      fillet: () => ({}),
      blend: () => null,
      chamfer: () => null,
      shell: () => null,
      place: () => ({}),
      scale: () => ({}),
      tessellate: () => TETRA,
      topology: () => null,
      exportStep: () => null,
      release: () => undefined,
    });
    const result = execute(doc, 'export_code', { language: 'cadquery' }, ctxWith(noTopology));
    expect((result.data as Code).notes.join(' ')).toContain('no analytic form');
  });
});

describe('centre lines of drilled parts', () => {
  it('marks every hole end-on in the top view and the pitch of a bolt circle', () => {
    const stock = plate([100, 100, 10]);
    const holes = execute(stock.doc, 'add_hole', {
      target: stock.id,
      face: { near: [50, 50, 10] },
      points: [
        [80, 50],
        [50, 80],
        [20, 50],
        [50, 20],
      ],
      hole: { kind: 'simple', diameter: 6 },
      extent: { kind: 'through_all' },
    });
    const entity = meshOf(holes.document, idOf(holes));
    const lines = centerLinePrimitives(entity, holes.document, TOP_VIEW, 'CENTER');
    expect(lines.filter((p) => p.type === 'line')).toHaveLength(8);
    expect(lines.filter((p) => p.type === 'circle')).toHaveLength(1);
  });
});

describe('an empty document exports nothing special', () => {
  it('has no feature notes', () => {
    expect(codeOf(createEmptyDocument(), 'cadquery').text).not.toContain('add_hole');
  });
});
