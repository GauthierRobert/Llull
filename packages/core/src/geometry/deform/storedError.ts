/** Chordal deviation of a STORED deformed mesh from the map (01 DEF §5.7), measured without rebuilding it: each vertex is pulled back to the source, and the edge middle of the source chord is mapped forward and compared with the stored chord. */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type DeformNode, mapLocal } from './laws';
import { resolveFrame, toLocal, toWorld } from './frame';
import { type SourceWindow, unmapLocal } from './inverse';

/**
 * max over the unique edges (a, b) of |F((F⁻¹a + F⁻¹b) / 2) − (a + b) / 2|.
 * @invariant an affine law keeps straight lines straight: 0
 * @failure degenerate frame -> null
 */
export function storedChordError(mesh: MeshData, node: Pick<DeformNode, 'law' | 'frame' | 'region'>, window?: SourceWindow): number | null {
  const frame = resolveFrame(node.frame);
  if (frame === null) return null;
  const { law, region } = node;
  if (law.kind === 'affine') return 0;
  if (region === undefined) return null;
  const pulled = new Map<number, Vec3>();
  const source = (v: number): Vec3 => {
    const known = pulled.get(v);
    if (known !== undefined) return known;
    const q = toLocal(frame, [mesh.positions[v * 3] as number, mesh.positions[v * 3 + 1] as number, mesh.positions[v * 3 + 2] as number]);
    const back = unmapLocal(law, region, q, window) ?? q;
    pulled.set(v, back);
    return back;
  };
  let worst = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [mesh.indices[t + k] as number, mesh.indices[t + ((k + 1) % 3)] as number];
      if (a >= b) continue;
      const [pa, pb] = [source(a), source(b)];
      const middle = toWorld(frame, mapLocal(law, region, [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]));
      for (let axis = 0; axis < 3; axis++) {
        const chord = ((mesh.positions[a * 3 + axis] as number) + (mesh.positions[b * 3 + axis] as number)) / 2;
        worst = Math.max(worst, Math.abs((middle[axis] as number) - chord));
      }
    }
  }
  return worst;
}
