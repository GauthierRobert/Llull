// Cage sub-element selection (04 DIR M1). Pure: maps a pick result to an element id, edits the selection set and resolves it against
// the entity. Ids are the persistent `v-1.7` / `f-1.2` / `e:<idA>|<idB>` strings, so a selection survives topology edits.

import type { SubdivisionEntity, Vec3 } from '@core/model/types';
import type { CagePick } from '@core/geometry/subd/pick';
import { faceArea, newellVector } from '@core/geometry/subd/topology';
import { centroid3 } from '@lib/vec3';
import { applyEulerXYZ } from '@lib/eulerRotation';

export type CageElementKind = 'vertex' | 'edge' | 'face';

export interface CageElement {
  readonly kind: CageElementKind;
  readonly id: string;
}

export interface CageSelection {
  readonly vertices: readonly string[];
  readonly edges: readonly string[];
  readonly faces: readonly string[];
}

export const EMPTY_CAGE_SELECTION: CageSelection = { vertices: [], edges: [], faces: [] };

const FIELD = { vertex: 'vertices', edge: 'edges', face: 'faces' } as const;

export const isSelectionEmpty = (selection: CageSelection): boolean =>
  selection.vertices.length + selection.edges.length + selection.faces.length === 0;

export const selectionCount = (selection: CageSelection): number =>
  selection.vertices.length + selection.edges.length + selection.faces.length;

/** The element a pick designates in the given mode (vertex mode only takes vertices, ...), or null. */
export function elementOfPick(pick: CagePick, mode: CageElementKind): CageElement | null {
  const hit = mode === 'vertex' ? pick.vertex : mode === 'edge' ? pick.edge : pick.face;
  return hit === null ? null : { kind: mode, id: hit.id };
}

export const hasElement = (selection: CageSelection, element: CageElement): boolean => selection[FIELD[element.kind]].includes(element.id);

/** Replace the selection by `element`, or toggle it into / out of the selection when `additive`. */
export function selectElement(selection: CageSelection, element: CageElement, additive: boolean): CageSelection {
  if (!additive) return { ...EMPTY_CAGE_SELECTION, [FIELD[element.kind]]: [element.id] };
  const field = FIELD[element.kind];
  const current = selection[field];
  return { ...selection, [field]: current.includes(element.id) ? current.filter((id) => id !== element.id) : [...current, element.id] };
}

/** Add elements of one kind (loop / ring selection), replacing the selection unless `additive`. */
export function selectElements(selection: CageSelection, kind: CageElementKind, ids: readonly string[], additive: boolean): CageSelection {
  const field = FIELD[kind];
  const base = additive ? selection : EMPTY_CAGE_SELECTION;
  return { ...base, [field]: [...new Set([...base[field], ...ids])] };
}

/** Parse `e:<idA>|<idB>`; null when malformed. */
export function parseEdgeId(id: string): readonly [string, string] | null {
  if (!id.startsWith('e:')) return null;
  const parts = id.slice(2).split('|');
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '' ? [parts[0] as string, parts[1] as string] : null;
}

/** Selection restricted to elements that still exist (after an undo or a topology command). */
export function pruneSelection(selection: CageSelection, entity: SubdivisionEntity): CageSelection {
  const vertices = new Set(entity.elementIds.vertices);
  const faces = new Set(entity.elementIds.faces);
  const edgeExists = (id: string): boolean => {
    const ends = parseEdgeId(id);
    return ends !== null && vertices.has(ends[0]) && vertices.has(ends[1]) && edgeIsInFaces(entity, ends);
  };
  const next: CageSelection = {
    vertices: selection.vertices.filter((id) => vertices.has(id)),
    edges: selection.edges.filter(edgeExists),
    faces: selection.faces.filter((id) => faces.has(id)),
  };
  const same =
    next.vertices.length === selection.vertices.length &&
    next.edges.length === selection.edges.length &&
    next.faces.length === selection.faces.length;
  return same ? selection : next;
}

function edgeIsInFaces(entity: SubdivisionEntity, [idA, idB]: readonly [string, string]): boolean {
  const a = entity.elementIds.vertices.indexOf(idA);
  const b = entity.elementIds.vertices.indexOf(idB);
  if (a < 0 || b < 0) return false;
  return entity.faces.some((face) =>
    face.some((v, i) => (v === a && face[(i + 1) % face.length] === b) || (v === b && face[(i + 1) % face.length] === a)),
  );
}

/** Indices of the cage vertices the selection touches (vertices, edge ends, face corners), ascending. */
export function selectionVertexIndices(entity: SubdivisionEntity, selection: CageSelection): number[] {
  const indexOf = new Map(entity.elementIds.vertices.map((id, index) => [id, index] as const));
  const found = new Set<number>();
  const add = (id: string): void => {
    const index = indexOf.get(id);
    if (index !== undefined) found.add(index);
  };
  selection.vertices.forEach(add);
  for (const edge of selection.edges) parseEdgeId(edge)?.forEach(add);
  for (const faceId of selection.faces) {
    const face = entity.faces[entity.elementIds.faces.indexOf(faceId)];
    face?.forEach((v) => found.add(v));
  }
  return [...found].sort((a, b) => a - b);
}

/** Entity-local centroid of the selected vertices, or null when nothing resolves. */
function selectionCentroidLocal(entity: SubdivisionEntity, selection: CageSelection): Vec3 | null {
  const indices = selectionVertexIndices(entity, selection);
  return indices.length === 0 ? null : centroid3(indices.map((v) => entity.vertices[v] as Vec3));
}

/** Local point to world (rotation then position, as the renderer places the entity). */
export function localToWorld(entity: Pick<SubdivisionEntity, 'position' | 'rotation'>, p: Vec3): Vec3 {
  const turned = applyEulerXYZ(p, [0, 0, 0], entity.rotation);
  return [turned[0] + entity.position[0], turned[1] + entity.position[1], turned[2] + entity.position[2]];
}

export function selectionCentroidWorld(entity: SubdivisionEntity, selection: CageSelection): Vec3 | null {
  const local = selectionCentroidLocal(entity, selection);
  return local === null ? null : localToWorld(entity, local);
}

/** Element-reference params of an `edit_subdivision_cage`-style command (only the non-empty kinds). */
export function selectionParams(selection: CageSelection): { vertices?: string[]; edges?: string[]; faces?: string[] } {
  return {
    ...(selection.vertices.length > 0 ? { vertices: [...selection.vertices] } : {}),
    ...(selection.edges.length > 0 ? { edges: [...selection.edges] } : {}),
    ...(selection.faces.length > 0 ? { faces: [...selection.faces] } : {}),
  };
}

/** Semi-sharp or infinite sharpness of cage edge `edgeId` (0 = smooth), for the readout. */
export function edgeSharpnessOf(entity: SubdivisionEntity, edgeId: string): number {
  const ends = parseEdgeId(edgeId);
  if (ends === null) return 0;
  const a = entity.elementIds.vertices.indexOf(ends[0]);
  const b = entity.elementIds.vertices.indexOf(ends[1]);
  const same = (x: number, y: number): boolean => (x === a && y === b) || (x === b && y === a);
  if (entity.creases.some(([x, y]) => same(x, y))) return Infinity;
  return entity.edgeSharpness?.find((e) => same(e.a, e.b))?.s ?? 0;
}

/** Unit world normal of cage face `faceId` (Newell), or null when the id is unknown or the face is degenerate. */
export function faceNormalWorld(entity: SubdivisionEntity, faceId: string): Vec3 | null {
  const face = entity.faces[entity.elementIds.faces.indexOf(faceId)];
  if (face === undefined) return null;
  const normal = newellVector(entity.vertices, face);
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length < 1e-12) return null;
  return applyEulerXYZ([normal[0] / length, normal[1] / length, normal[2] / length], [0, 0, 0], entity.rotation);
}

/** Starting width of the modal inset: 15 % of the side of the smallest selected face (document units); 0.1 when nothing resolves. */
export function defaultInsetThickness(entity: SubdivisionEntity, selection: CageSelection): number {
  const sides = selection.faces.flatMap((faceId) => {
    const face = entity.faces[entity.elementIds.faces.indexOf(faceId)];
    return face === undefined ? [] : [Math.sqrt(faceArea(entity.vertices, face))];
  });
  const smallest = Math.min(...sides);
  return Number.isFinite(smallest) && smallest > 0 ? Math.round(smallest * 0.15 * 1e4) / 1e4 : 0.1;
}
