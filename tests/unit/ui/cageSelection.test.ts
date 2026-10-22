import { describe, expect, it } from 'vitest';
import { type CadDocument, type SubdivisionEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { localRay, pickCage } from '@core/geometry/subd/pick';
import {
  EMPTY_CAGE_SELECTION,
  defaultInsetThickness,
  edgeSharpnessOf,
  elementOfPick,
  faceNormalWorld,
  hasElement,
  isSelectionEmpty,
  localToWorld,
  parseEdgeId,
  pruneSelection,
  selectElement,
  selectElements,
  selectionCentroidWorld,
  selectionParams,
  selectionVertexIndices,
} from '@ui/viewport/3d/cage/cageSelection';
import { hintFor, selectionText, sharpnessText } from '@ui/viewport/3d/cage/cageBarModel';

function cube(extra: object = {}): { doc: CadDocument; id: string; cage: SubdivisionEntity } {
  const result = execute(createEmptyDocument(), 'add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 1, ...extra });
  const id = result.affected[0] as string;
  return { doc: result.document, id, cage: result.document.entities[id] as SubdivisionEntity };
}

describe('pick -> element', () => {
  const { cage } = cube();
  // From +Z straight down onto the top face, right above a cage corner.
  const corner = cage.vertices.find((v) => v[0] === 1 && v[1] === 1 && v[2] === 1);
  const ray = { origin: [1, 1, 10] as const, direction: [0, 0, -1] as const };
  const pick = pickCage(cage, ray, 0.1);

  it('takes only the element kind of the current mode', () => {
    expect(corner).toBeDefined();
    expect(elementOfPick(pick, 'vertex')?.kind).toBe('vertex');
    expect(elementOfPick(pick, 'face')?.kind).toBe('face');
    expect(elementOfPick(pick, 'edge')?.id).toMatch(/^e:v-/);
  });
  it('returns null when nothing of that kind is under the ray', () => {
    const miss = pickCage(cage, { origin: [9, 9, 10], direction: [0, 0, -1] }, 0.1);
    expect(elementOfPick(miss, 'vertex')).toBeNull();
    expect(elementOfPick(miss, 'face')).toBeNull();
  });
  it('picks through the entity frame (position and rotation)', () => {
    const placed = { ...cage, position: [5, 0, 0] as const, rotation: [0, 0, 0] as const };
    const local = localRay(placed, { origin: [6, 1, 10], direction: [0, 0, -1] });
    expect(pickCage(placed as SubdivisionEntity, local, 0.1).vertex?.id).toBe(pick.vertex?.id);
  });
});

describe('selection editing', () => {
  const a = { kind: 'vertex', id: 'v-1.0' } as const;
  const b = { kind: 'vertex', id: 'v-1.1' } as const;
  it('replaces without a modifier and toggles with one', () => {
    const one = selectElement(EMPTY_CAGE_SELECTION, a, false);
    const two = selectElement(one, b, true);
    expect(two.vertices).toEqual(['v-1.0', 'v-1.1']);
    expect(selectElement(two, a, true).vertices).toEqual(['v-1.1']);
    expect(selectElement(two, { kind: 'face', id: 'f-1.2' }, false)).toEqual({ vertices: [], edges: [], faces: ['f-1.2'] });
    expect(hasElement(two, b)).toBe(true);
  });
  it('adds loops to the selection without duplicates', () => {
    const base = selectElement(EMPTY_CAGE_SELECTION, { kind: 'edge', id: 'e:v-1.0|v-1.1' }, false);
    expect(selectElements(base, 'edge', ['e:v-1.0|v-1.1', 'e:v-1.1|v-1.2'], true).edges).toHaveLength(2);
    expect(selectElements(base, 'edge', ['e:v-1.5|v-1.6'], false).edges).toEqual(['e:v-1.5|v-1.6']);
  });
  it('emits only non-empty kinds as command params', () => {
    expect(selectionParams({ vertices: ['v-1.0'], edges: [], faces: [] })).toEqual({ vertices: ['v-1.0'] });
    expect(isSelectionEmpty(EMPTY_CAGE_SELECTION)).toBe(true);
  });
  it('parses edge ids', () => {
    expect(parseEdgeId('e:v-1.0|v-1.1')).toEqual(['v-1.0', 'v-1.1']);
    expect(parseEdgeId('v-1.0')).toBeNull();
    expect(parseEdgeId('e:|x')).toBeNull();
  });
});

describe('resolution against the entity', () => {
  const { doc, id, cage } = cube();
  const face = cage.elementIds.faces[0] as string;

  it('maps a face to its corner vertices and a world centroid', () => {
    const selection = { ...EMPTY_CAGE_SELECTION, faces: [face] };
    expect(selectionVertexIndices(cage, selection)).toHaveLength(4);
    const centre = selectionCentroidWorld({ ...cage, position: [3, 0, 0] }, selection);
    expect(Math.abs((centre?.[0] ?? 0) - 3) + Math.abs(centre?.[1] ?? 0) + Math.abs(centre?.[2] ?? 0)).toBeGreaterThan(0.9);
    expect(localToWorld({ position: [1, 2, 3], rotation: [0, 0, 0] }, [1, 1, 1])).toEqual([2, 3, 4]);
  });
  it('gives a unit world normal of a face, turned by the entity rotation', () => {
    const normal = faceNormalWorld(cage, face);
    expect(Math.hypot(...(normal ?? [0, 0, 0]))).toBeCloseTo(1, 9);
    expect(faceNormalWorld(cage, 'f-9.9')).toBeNull();
    const turned = faceNormalWorld({ ...cage, rotation: [Math.PI / 2, 0, 0] }, face);
    expect(turned).not.toEqual(normal);
  });
  it('prunes ids that no longer exist, keeping the same object when nothing changed', () => {
    const live = { vertices: [cage.elementIds.vertices[0] as string], edges: [], faces: [face] };
    expect(pruneSelection(live, cage)).toBe(live);
    const stale = { vertices: ['v-9.9', ...live.vertices], edges: ['e:v-9.1|v-9.2'], faces: [face, 'f-9.9'] };
    expect(pruneSelection(stale, cage)).toEqual(live);
    const [a, b] = [cage.elementIds.vertices[0] as string, cage.elementIds.vertices[6] as string];
    // two vertices that share no edge are not a cage edge
    expect(pruneSelection({ ...EMPTY_CAGE_SELECTION, edges: [`e:${a}|${b}`] }, cage).edges).toEqual([]);
  });
  it('starts an inset at 15 percent of the smallest face side', () => {
    expect(defaultInsetThickness(cage, { ...EMPTY_CAGE_SELECTION, faces: [face] })).toBeCloseTo(0.3, 4);
    expect(defaultInsetThickness(cage, EMPTY_CAGE_SELECTION)).toBe(0.1);
  });
  it('reads edge sharpness from creases and semi-sharp entries', () => {
    const edge = `e:${cage.elementIds.vertices[0]}|${cage.elementIds.vertices[1]}`;
    expect(edgeSharpnessOf(cage, edge)).toBe(0);
    const infinite = { ...cage, creases: [[0, 1]] as const } as unknown as SubdivisionEntity;
    expect(edgeSharpnessOf(infinite, edge)).toBe(Infinity);
    const semi = { ...cage, edgeSharpness: [{ a: 1, b: 0, s: 2 }] } as SubdivisionEntity;
    expect(edgeSharpnessOf(semi, edge)).toBe(2);
    expect(sharpnessText(semi, { ...EMPTY_CAGE_SELECTION, edges: [edge] })).toBe('Edge: sharpness 2');
    expect(sharpnessText(infinite, { ...EMPTY_CAGE_SELECTION, edges: [edge] })).toBe('Edge: infinitely sharp');
    expect(sharpnessText(cage, { ...EMPTY_CAGE_SELECTION, vertices: ['v-1.0'] })).toBeNull();
    expect(doc.entities[id]).toBe(cage);
  });
});

describe('bar texts', () => {
  it('counts the selection', () => {
    expect(selectionText(EMPTY_CAGE_SELECTION)).toBe('Nothing selected');
    expect(selectionText({ vertices: ['a'], edges: ['b', 'c'], faces: [] })).toBe('1 vertex, 2 edges');
    expect(selectionText({ vertices: ['a', 'b'], edges: [], faces: ['f'] })).toBe('2 vertices, 1 face');
  });
  it('hints the next gesture', () => {
    expect(hintFor('loop_cut', EMPTY_CAGE_SELECTION, 2)).toContain('2 loops');
    expect(hintFor('select', EMPTY_CAGE_SELECTION, 1)).toContain('Click');
    expect(hintFor('select', { vertices: [], edges: [], faces: ['f'] }, 1)).toContain('Alt-drag');
    expect(hintFor('select', { vertices: ['v'], edges: [], faces: [] }, 1)).toContain('gizmo');
  });
});
