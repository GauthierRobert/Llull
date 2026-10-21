/**
 * Curved-face detection on a triangle mesh: coplanar triangles are merged into planar regions; regions that meet at a shallow dihedral angle
 * (a polygonal approximation of a smooth surface) are linked, and a link-connected group of four or more regions is a curved face.
 * A box, a prism or a chamfer-free plate has none; a cylinder, sphere, cone, torus, fillet or sweep has.
 * The construction recipe is the exact signal (`isCurvedPart`): a coarse polygonal cylinder (36 degrees per facet or more) is curved by its
 * recipe even though no dihedral heuristic can tell it from a prism; the dihedral heuristic is the fallback for recipe-less meshes.
 */

import { recipeOf } from '@core/geometry/shapeRecipe';
import type { Entity, MeshData, ShapeRecipe, SolidKind } from '@core/model/types';
import { cross3, dot3, sub3 } from '@lib/vec3';

/** Dihedral angle (degrees) below which two adjacent triangles are one planar region. */
const COPLANAR_DEGREES = 0.5;
/** Largest dihedral angle (degrees) still read as a facet of a smooth surface (a 10-gon has 36 degrees per facet). */
const SMOOTH_DEGREES = 35;
/** Regions a smooth group needs to be a curved face (three links); a single chamfer joins only three. */
const MIN_REGIONS = 4;

/** Solid kinds whose surface is smooth by construction (a box, wedge, pyramid or plain extrusion is not; an extruded prism is ambiguous). */
const CURVED_KINDS: ReadonlySet<SolidKind> = new Set<SolidKind>([
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'revolution',
  'sweep',
  'loft',
  'subdivision',
]);

/** True when the recipe tree contains a smooth-by-construction solid, a fillet or a blend. */
function recipeCurved(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'solid':
      return CURVED_KINDS.has(recipe.entity.kind as SolidKind);
    case 'boolean':
      return recipeCurved(recipe.a) || recipeCurved(recipe.b);
    case 'fillet':
    case 'blend':
      return true;
    case 'chamfer':
    case 'shell':
    case 'place':
    case 'scale':
    case 'feature':
    case 'faceOp':
      return recipeCurved(recipe.source);
    default:
      return false;
  }
}

/** True when the part is curved: its construction recipe says so, else (a plain mesh, an extrusion, an import) the triangles do. */
export function isCurvedPart(entity: Entity, mesh: MeshData): boolean {
  return recipeCurved(recipeOf(entity)) || hasCurvedFaces(mesh);
}

type Vec = readonly [number, number, number];

class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(item: number): number {
    let root = item;
    while ((this.parent[root] ?? root) !== root) root = this.parent[root] ?? root;
    let walk = item;
    while (walk !== root) {
      const next = this.parent[walk] ?? root;
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/** True when the triangle mesh has at least one curved (polygonally approximated) face. */
function hasCurvedFaces(mesh: MeshData): boolean {
  const triangles = Math.floor(mesh.indices.length / 3);
  if (triangles < MIN_REGIONS) return false;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const axis = i % 3;
    lo[axis] = Math.min(lo[axis] ?? Infinity, mesh.positions[i] ?? 0);
    hi[axis] = Math.max(hi[axis] ?? -Infinity, mesh.positions[i] ?? 0);
  }
  const quantum = Math.max(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) * 1e-7, Number.MIN_VALUE);
  const welded = new Map<string, number>();
  const weld = (vertex: number): number => {
    const key = [0, 1, 2].map((axis) => Math.round((mesh.positions[vertex * 3 + axis] ?? 0) / quantum)).join(',');
    const found = welded.get(key);
    if (found !== undefined) return found;
    welded.set(key, welded.size);
    return welded.size - 1;
  };
  const point = (vertex: number): Vec => [
    mesh.positions[vertex * 3] ?? 0,
    mesh.positions[vertex * 3 + 1] ?? 0,
    mesh.positions[vertex * 3 + 2] ?? 0,
  ];
  const normals: (Vec | null)[] = [];
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triangles; t++) {
    const corners = [0, 1, 2].map((c) => mesh.indices[3 * t + c] ?? 0);
    const [a, b, c] = corners.map(point) as [Vec, Vec, Vec];
    const normal = cross3(sub3(b, a), sub3(c, a));
    const length = Math.hypot(...normal);
    normals.push(length > 0 ? [normal[0] / length, normal[1] / length, normal[2] / length] : null);
    const ids = corners.map(weld);
    for (let c = 0; c < 3; c++) {
      const from = ids[c] ?? 0;
      const to = ids[(c + 1) % 3] ?? 0;
      if (from === to) continue;
      const key = from < to ? `${from}_${to}` : `${to}_${from}`;
      edges.set(key, [...(edges.get(key) ?? []), t]);
    }
  }
  const angleOf = (first: number, second: number): number | null => {
    const n1 = normals[first];
    const n2 = normals[second];
    return n1 == null || n2 == null ? null : (Math.acos(Math.max(-1, Math.min(1, dot3(n1, n2)))) * 180) / Math.PI;
  };
  const planar = new DisjointSet(triangles);
  const shared: [number, number, number][] = [];
  for (const owners of edges.values()) {
    if (owners.length !== 2) continue;
    const angle = angleOf(owners[0] ?? 0, owners[1] ?? 0);
    if (angle === null) continue;
    if (angle < COPLANAR_DEGREES) planar.union(owners[0] ?? 0, owners[1] ?? 0);
    else shared.push([owners[0] ?? 0, owners[1] ?? 0, angle]);
  }
  const smooth = new DisjointSet(triangles);
  for (const [first, second, angle] of shared) if (angle <= SMOOTH_DEGREES) smooth.union(planar.find(first), planar.find(second));
  const sizes = new Map<number, Set<number>>();
  for (let t = 0; t < triangles; t++) {
    const group = smooth.find(planar.find(t));
    const regions = sizes.get(group) ?? new Set<number>();
    regions.add(planar.find(t));
    sizes.set(group, regions);
  }
  return [...sizes.values()].some((regions) => regions.size >= MIN_REGIONS);
}
