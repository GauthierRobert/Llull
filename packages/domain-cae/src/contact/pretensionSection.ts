/**
 * Mesh cut of a bolt pretension (PHY-06 TR-CNT-03): the bolt part's elements are split by the side of the section plane their centroid lies on
 * (low = the negative side of the plane normal, high = the positive one). The cut is every face shared by an element of each side; the nodes
 * shared by both sides are the ones the deck duplicates. The cut is complete by construction (it separates the two classes), it follows the plane
 * within one element size and needs no planar imprint: the jump across it is a rigid translation of the high side along the normal.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, scale3, sub3, dot3 } from '@lib/vec3';
import { faceNodes, indexMesh, type MeshElement, type MeshIndex } from '../thermal/meshGeometry';

export interface PretensionCut {
  /** Faces of the low-side elements shared with a high-side element, sorted (element id, CalculiX face label). */
  readonly faces: readonly (readonly [elementId: number, face: number])[];
  /** Ids of the high-side elements of the part: the ones that take the duplicated nodes. */
  readonly highElements: ReadonlySet<number>;
  /** Mesh nodes shared by a low-side and a high-side element (corners and mid-side nodes of the cut), ascending. */
  readonly nodes: readonly number[];
  /** Cross-section area (analysis length squared): the cut faces projected on the plane (sum of area vector . normal, so a jagged cut counts once) and the diameter of the circle of that area. */
  readonly area: number;
  readonly diameter: number;
  /** Centroid of the cut faces weighted by their projected area (analysis length unit). */
  readonly centroid: Vec3;
  /** Unit section normal, from the low to the high side. */
  readonly normal: Vec3;
}

export interface CutRefusal {
  readonly code: 'CNT_PRETENSION_SECTION_INVALID';
  readonly message: string;
}

const key = (nodes: readonly number[]): string =>
  nodes
    .slice(0, 3)
    .sort((a, b) => a - b)
    .join(',');

const LABELS = [1, 2, 3, 4] as const;

/** Number of separate pieces (connected through shared edges) of the cut faces; a clean shank cut is one. */
function pieceCount(index: MeshIndex, faces: readonly (readonly [number, number])[]): number {
  const parent = faces.map((_, face) => face);
  const find = (face: number): number => {
    let root = face;
    while (parent[root] !== root) root = parent[root] ?? root;
    return root;
  };
  const edgeOwner = new Map<string, number>();
  faces.forEach(([elementId, label], face) => {
    const element = index.elements.get(elementId);
    const nodes = (element === undefined ? null : faceNodes(element, label))?.slice(0, 3) ?? [];
    for (const [a = 0, b = 0] of [
      [nodes[0], nodes[1]],
      [nodes[1], nodes[2]],
      [nodes[2], nodes[0]],
    ]) {
      const edge = a < b ? `${a},${b}` : `${b},${a}`;
      const other = edgeOwner.get(edge);
      if (other === undefined) edgeOwner.set(edge, face);
      else parent[find(face)] = find(other);
    }
  });
  return new Set(faces.map((_, face) => find(face))).size;
}

/** Corner coordinates of an element (the cut refuses a part with a node that has none, so none is skipped there). */
const cornersOf = (index: MeshIndex, element: MeshElement): Vec3[] =>
  element.nodes.slice(0, 4).flatMap((node) => {
    const at = index.coordinates.get(node);
    return at === undefined ? [] : [at];
  });

/** Area vector (cross product / 2) of the triangle `a b c`. */
const triangleAreaVector = (a: Vec3, b: Vec3, c: Vec3): Vec3 => scale3(cross3(sub3(b, a), sub3(c, a)), 0.5);

/** Area vector of the face `a b c` of `element`, pointing out of the element (away from its centroid). */
export function outwardAreaVector(index: MeshIndex, element: MeshElement, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const centre = scale3(add3(add3(a, b), c), 1 / 3);
  const corners = cornersOf(index, element);
  const inside = scale3(
    corners.reduce((sum, corner) => add3(sum, corner), [0, 0, 0] as Vec3),
    1 / corners.length,
  );
  const raw = triangleAreaVector(a, b, c);
  return dot3(raw, sub3(centre, inside)) >= 0 ? raw : scale3(raw, -1);
}

/**
 * Duplicate node numbers of the cuts, shared by the deck writer and the result readers: the bolts in order, each cut's nodes ascending, numbered
 * from the node above the highest mesh node.
 */
export function numberDuplicates(mesh: FeMeshArtifact, cuts: readonly PretensionCut[]): Map<number, number>[] {
  let next = mesh.nodes.reduce((highest, [id]) => Math.max(highest, id), 0) + 1;
  return cuts.map((cut) => new Map(cut.nodes.map((node) => [node, next++])));
}

/**
 * Cut of the part `entityId` by the plane through `point` (analysis length unit) with direction `normal`.
 * @invariant pure; deterministic (faces and nodes sorted); element-centroid classification
 * @failure zero normal, part without elements, all elements on one side, or more than one separate cut -> CNT_PRETENSION_SECTION_INVALID
 */
export function pretensionCut(
  mesh: FeMeshArtifact,
  entityId: string,
  point: Vec3,
  normal: Vec3,
  index: MeshIndex = indexMesh(mesh),
): PretensionCut | CutRefusal {
  const refuse = (message: string): CutRefusal => ({ code: 'CNT_PRETENSION_SECTION_INVALID', message });
  const length = Math.hypot(...normal);
  if (!(length > 0)) return refuse('the section normal is the zero vector');
  const unit = scale3(normal, 1 / length);
  const part = [...index.elements.values()].filter((element) => element.entityId === entityId);
  if (part.length === 0) return refuse(`part '${entityId}' has no tetrahedral elements in the mesh`);
  const missing = part.flatMap((element) => element.nodes.filter((node) => !index.coordinates.has(node)))[0];
  if (missing !== undefined) return refuse(`part '${entityId}' uses node ${missing}, which has no coordinates in the mesh`);
  const high = new Set<number>();
  for (const element of part) {
    const corners = cornersOf(index, element);
    const centroid = scale3(
      corners.reduce((sum, corner) => add3(sum, corner), [0, 0, 0] as Vec3),
      1 / corners.length,
    );
    if (dot3(sub3(centroid, point), unit) >= 0) high.add(element.id);
  }
  if (high.size === 0 || high.size === part.length)
    return refuse(`the plane does not cross part '${entityId}': every element lies on one side of it`);
  const owners = new Map<string, MeshElement[]>();
  for (const element of part)
    for (const label of LABELS) {
      const nodes = faceNodes(element, label);
      if (nodes !== null) owners.set(key(nodes), [...(owners.get(key(nodes)) ?? []), element]);
    }
  const faces: [number, number][] = [];
  const lowNodes = new Set<number>();
  const highNodes = new Set<number>();
  for (const element of part) for (const node of element.nodes) (high.has(element.id) ? highNodes : lowNodes).add(node);
  for (const element of part) {
    if (high.has(element.id)) continue;
    for (const label of LABELS) {
      const nodes = faceNodes(element, label);
      if ((nodes === null ? [] : (owners.get(key(nodes)) ?? [])).some((other) => high.has(other.id))) faces.push([element.id, label]);
    }
  }
  faces.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pieces = pieceCount(index, faces);
  if (pieces !== 1) return refuse(`the plane cuts part '${entityId}' in ${pieces} separate sections (a bolt shank needs exactly one)`);
  const cutNodes = [...lowNodes].filter((node) => highNodes.has(node)).sort((a, b) => a - b);
  const onCut = new Set(cutNodes);
  for (const element of index.elements.values()) {
    const shared = element.entityId === entityId ? undefined : element.nodes.find((node) => onCut.has(node));
    if (shared !== undefined)
      return refuse(
        `cut node ${shared} is also a node of part '${element.entityId}' (a conformal mesh shares nodes between parts); move the plane`,
      );
  }
  let area = 0;
  let weighted: Vec3 = [0, 0, 0];
  for (const [elementId, label] of faces) {
    const element = index.elements.get(elementId);
    const [a, b, c] =
      (element === undefined ? null : faceNodes(element, label))?.slice(0, 3).map((node) => index.coordinates.get(node)) ?? [];
    if (element === undefined || a === undefined || b === undefined || c === undefined) continue;
    const centre = scale3(add3(add3(a, b), c), 1 / 3);
    const projected = dot3(outwardAreaVector(index, element, a, b, c), unit);
    area += projected;
    weighted = add3(weighted, scale3(centre, projected));
  }
  return {
    faces,
    highElements: high,
    nodes: cutNodes,
    area,
    diameter: Math.sqrt((4 * area) / Math.PI),
    centroid: area > 0 ? scale3(weighted, 1 / area) : point,
    normal: unit,
  };
}

export const isCutRefusal = (value: PretensionCut | CutRefusal): value is CutRefusal => 'code' in value;
