/** The outer skin of a solid tetrahedral mesh as triangles of node ids — what a result contour plot paints. */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';

export type SkinTriangle = readonly [number, number, number];

/** Corner triples of the four tetrahedron faces (0-based corner indices). */
const TET_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 2, 3],
  [0, 1, 3, 2],
  [1, 2, 3, 0],
  [0, 2, 3, 1],
];

/** C3D10 midside node index (0-based in the element's node list) of the edge between two corners. */
const MIDSIDE: Readonly<Record<string, number>> = { '0-1': 4, '1-2': 5, '0-2': 6, '0-3': 7, '1-3': 8, '2-3': 9 };
const midside = (a: number, b: number): number | undefined => MIDSIDE[a < b ? `${a}-${b}` : `${b}-${a}`];

interface Face {
  readonly corners: readonly [number, number, number];
  readonly opposite: number;
  readonly nodes: readonly number[];
  readonly quadratic: boolean;
}

function facesOfBlock(block: FeMeshArtifact['blocks'][number]): Face[] {
  if (block.type !== 'C3D4' && block.type !== 'C3D10') return [];
  const quadratic = block.type === 'C3D10';
  const faces: Face[] = [];
  for (const element of block.elements) {
    const nodes = element.slice(1);
    for (const [a, b, c, d] of TET_FACES) {
      const [na, nb, nc, nd] = [nodes[a], nodes[b], nodes[c], nodes[d]];
      if (na === undefined || nb === undefined || nc === undefined || nd === undefined) continue;
      const mids = quadratic
        ? [midside(a, b), midside(b, c), midside(a, c)].map((index) => (index === undefined ? undefined : nodes[index]))
        : [];
      const complete = mids.every((node) => node !== undefined);
      faces.push({ corners: [na, nb, nc], opposite: nd, nodes: complete ? (mids as number[]) : [], quadratic: quadratic && complete });
    }
  }
  return faces;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Orders a corner triple so its normal points away from the element's opposite node (outward). */
function outward(face: Face, at: (node: number) => Vec3 | undefined): readonly [number, number, number] | null {
  const [a, b, c] = face.corners.map(at);
  const d = at(face.opposite);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  const u = sub(b, a);
  const v = sub(c, a);
  const normal: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const toOpposite = sub(d, a);
  const side = normal[0] * toOpposite[0] + normal[1] * toOpposite[1] + normal[2] * toOpposite[2];
  return side > 0 ? [face.corners[0], face.corners[2], face.corners[1]] : face.corners;
}

/**
 * Boundary faces of the C3D4 / C3D10 blocks (faces used by exactly one element), outward-wound; a quadratic face is split into its 4
 * corner/midside sub-triangles so the plot follows the quadratic field. Other element types contribute nothing.
 * @pure
 */
export function meshSkin(mesh: FeMeshArtifact, coordinates: ReadonlyMap<number, Vec3>): SkinTriangle[] {
  const count = new Map<string, number>();
  const faces = mesh.blocks.flatMap(facesOfBlock);
  const keyOf = (face: Face): string => [...face.corners].sort((x, y) => x - y).join(',');
  for (const face of faces) count.set(keyOf(face), (count.get(keyOf(face)) ?? 0) + 1);
  const at = (node: number): Vec3 | undefined => coordinates.get(node);
  const skin: SkinTriangle[] = [];
  for (const face of faces) {
    if (count.get(keyOf(face)) !== 1) continue;
    const ordered = outward(face, at);
    if (ordered === null) continue;
    if (!face.quadratic) {
      skin.push(ordered);
      continue;
    }
    const flipped = ordered[1] !== face.corners[1];
    const [mab, mbc, mac] = face.nodes;
    if (mab === undefined || mbc === undefined || mac === undefined) continue;
    const [a, b, c] = face.corners;
    const subs: SkinTriangle[] = [
      [a, mab, mac],
      [mab, b, mbc],
      [mac, mbc, c],
      [mab, mbc, mac],
    ];
    for (const triangle of subs) skin.push(flipped ? [triangle[0], triangle[2], triangle[1]] : triangle);
  }
  return skin;
}
