/**
 * BLD M5 / DES-6c: export_code rebuilds a variable or two-leg chamfer of a straight edge between planes (CadQuery / build123d: the OCP loft-and-boolean
 * the native kernel uses), refuses by name where it cannot (FreeCAD at run time, OpenSCAD as the exact mesh) and never writes a constant chamfer instead.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { modificationFeature } from '@core/codegen/recipeLowering';
import type { ShapeRecipe } from '@core/model/types';
import { scriptedKernel } from '../helpers/blendKernel';

afterEach(() => setGeometryKernel(null));

const LANGUAGES = ['cadquery', 'build123d', 'freecad', 'openscad'] as const;

const chamfered = (params: Record<string, unknown>): CadDocument => {
  // the face nearest to the side-1 point is the one whose index is closest to its x
  setGeometryKernel(scriptedKernel({ distance: (face, point) => Math.abs(face - point[0]) }));
  const box = execute(createEmptyDocument(), 'add_box', { size: [20, 10, 5] });
  const result = execute(box.document, 'chamfer_edge', { id: box.affected[0], ...params });
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return result.document;
};
const code = (doc: CadDocument, language: string): { text: string; summary: string } => {
  const result = execute(doc, 'export_code', { language });
  return { text: (result.data as { text: string }).text, summary: result.summary };
};
const callLine = (text: string): string => text.split('\n').find((line) => line.startsWith('box_1 = chamfer')) ?? '';
/** The generated construction: the OCP helper block of the runtime and the model's call. */
const construction = (text: string): string => {
  const start = text.indexOf('def _v_sub(');
  const end = text.indexOf('def _chamfer_legs(');
  const helper = start < 0 ? '' : text.slice(start, text.indexOf('\n\n\ndef ', end + 10));
  return `${helper}\n${callLine(text)}`;
};

const VARIABLE = { edgeIndices: [0], distance: 1, distanceEnd: 1.5 };
const TWO_LEG = { edgeIndices: [0], distance: 1, distance2: 2, distanceEnd: 1.5, distance2End: 2.5, side1Near: [0, 0, 0] };

describe('export_code of variable and two-leg chamfers', () => {
  it('a variable chamfer is one chamfer_legs call with equal legs and the OCP loft-and-boolean construction', () => {
    const doc = chamfered(VARIABLE);
    for (const language of ['cadquery', 'build123d']) {
      const { text, summary } = code(doc, language);
      expect(callLine(text), language).toBe('box_1 = chamfer_legs(box_1, [0], 1, 1.5, 1, 1.5, near=[(10, 0, 0)])');
      expect(text, language).toContain('BRepOffsetAPI_ThruSections(True, True)');
      expect(text, language).toContain('(True, BRepAlgoAPI_Cut), (False, BRepAlgoAPI_Fuse)');
      expect(summary, language).not.toContain('BLD_CODEGEN_UNSUPPORTED');
      expect(text, language).not.toMatch(/^\w+ = mesh\(\[/m);
    }
  });

  it('a two-leg variable chamfer names the face that carries the first leg by its outward normal', () => {
    const { text } = code(chamfered(TWO_LEG), 'cadquery');
    expect(callLine(text)).toBe('box_1 = chamfer_legs(box_1, [0], 1, 1.5, 2, 2.5, lead=[(1, 0, 0)], near=[(10, 0, 0)])');
    const onZ = code(chamfered({ ...TWO_LEG, side1Near: [1, 0, 0] }), 'cadquery').text;
    expect(callLine(onZ)).toContain('lead=[(0, 0, 1)]');
  });

  it('a constant two-leg chamfer is the same construction with constant legs', () => {
    const { text } = code(chamfered({ edgeIndices: [0], distance: 1, distance2: 2, side1Near: [0, 0, 0] }), 'build123d');
    expect(callLine(text)).toBe('box_1 = chamfer_legs(box_1, [0], 1, 1, 2, 2, lead=[(1, 0, 0)], near=[(10, 0, 0)])');
  });

  it('a constant symmetric chamfer keeps its OCCT lowering', () => {
    const { text } = code(chamfered({ edgeIndices: [0], distance: 1 }), 'cadquery');
    expect(callLine(text)).toBe('box_1 = chamfer(box_1, [0], 1, near=[(10, 0, 0)])');
  });

  it('the emitted construction is deterministic, one per target', () => {
    const doc = chamfered(TWO_LEG);
    for (const language of LANGUAGES) expect(code(doc, language).text, language).toBe(code(doc, language).text);
    for (const language of ['cadquery', 'build123d', 'freecad'])
      expect(construction(code(doc, language).text), language).toMatchSnapshot(language);
  });

  it('FreeCAD calls the helper and refuses by name at run time; OpenSCAD carries the exact result as triangles', () => {
    const doc = chamfered(TWO_LEG);
    const freecad = code(doc, 'freecad').text;
    expect(callLine(freecad)).toContain('chamfer_legs(box_1, [0], 1, 1.5, 2, 2.5');
    expect(freecad).toContain('def chamfer_legs(shape, edges, first, last, second, second_last, lead=None, near=None):');
    expect(freecad).toContain('raise ValueError("BLD_CODEGEN_UNSUPPORTED: variable and two-leg chamfers');
    const openscad = code(doc, 'openscad').text;
    expect(openscad).toContain('polyhedron(points');
    expect(openscad).not.toContain('chamfer_legs');
  });

  it('the Python helper records the chamfer_edge step it stands for (replay by apply_code_trace)', () => {
    const { text } = code(chamfered(TWO_LEG), 'cadquery');
    expect(text).toContain('feature = _record("chamfer_edge", params)');
    expect(text).toContain('"distanceEnd": float(last)');
    expect(text).toContain('"side1Near": [float(c) for c in points[0]]');
  });
});

describe('what the chamfer lowering refuses: BLD_CODEGEN_UNSUPPORTED and the exact mesh, in every language', () => {
  const refused = (doc: CadDocument): void => {
    for (const language of LANGUAGES) {
      const { text, summary } = code(doc, language);
      expect(summary, language).toContain('BLD_CODEGEN_UNSUPPORTED');
      expect(text, language).not.toMatch(/^box_1 = chamfer/m);
      expect(text, language).toMatch(/^\w+ = mesh\(\[|polyhedron\(points/m);
    }
  };

  it('a curved edge (the kernel reports a circle)', () => refused(chamfered({ edgeIndices: [1], distance: 1, distanceEnd: 2 })));
  it('a distance-angle chamfer', () => refused(chamfered({ edgeIndices: [0], distance: 1, angleDeg: 30, side1Near: [0, 0, 0] })));
  it('two-leg chamfer of several edges (one side-1 point cannot name every leading face)', () =>
    refused(chamfered({ edgeIndices: [0, 2], distance: 1, distance2: 2, side1Near: [0, 0, 0] })));
  it('a leading face that is not a plane', () => refused(chamfered({ edgeIndices: [2], distance: 1, distance2: 2, side1Near: [2, 0, 0] })));

  it('a recipe that lists no edges (every edge) is refused: a variable chamfer must name its edges', () => {
    setGeometryKernel(scriptedKernel());
    const source = { op: 'solid', entity: { kind: 'box' } } as unknown as ShapeRecipe;
    const base = { step: 1, command: 'chamfer_edge', variable: 'box_1' };
    const node = (edges: number[]): ShapeRecipe => ({ op: 'chamfer', source, edges, size: 1, sizeEnd: 2 });
    expect(modificationFeature(node([]) as never, base, getGeometryKernel(), undefined)).toBeNull();
    expect(modificationFeature(node([0]) as never, base, getGeometryKernel(), undefined)?.op).toBe('chamfer');
  });

  it('a kernel without exact topology at export (it cannot tell a straight edge)', () => {
    const doc = chamfered(VARIABLE);
    setGeometryKernel(scriptedKernel({ noTopology: true }));
    refused(doc);
  });
});
