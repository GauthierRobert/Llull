/** Initial overclosure of a contact pair on the mesh (PHY-06 CNT_INITIAL_OVERCLOSURE): slave corner nodes behind the master faces. */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { ContactPair } from '@core/model/contact';
import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, sub3 } from '@lib/vec3';
import { faceNodes, indexMesh, type MeshIndex } from '../thermal/meshGeometry';
import { pairTargetKey } from '../hash/targets';

/** Most node x face tests one check may run (named guard: larger meshes skip the measurement with a note). */
const MAX_OVERCLOSURE_TESTS = 2e7;

/** Barycentric slack that still counts a projection as inside a master triangle. */
const INSIDE_SLACK = 1e-9;

interface MasterFace {
  readonly a: Vec3;
  readonly e1: Vec3;
  readonly e2: Vec3;
  /** Unit outward normal (away from the element's fourth corner). */
  readonly normal: Vec3;
}

function masterFaces(index: MeshIndex, mesh: FeMeshArtifact, pair: ContactPair): MasterFace[] {
  const key = pairTargetKey(pair.id, 'M');
  const faces: MasterFace[] = [];
  for (const [elementId, label] of Object.hasOwn(mesh.faceSets, key) ? (mesh.faceSets[key] ?? []) : []) {
    const element = index.elements.get(elementId);
    const nodes = element === undefined ? null : faceNodes(element, label);
    if (element === undefined || nodes === null) continue;
    const [a, b, c] = nodes.slice(0, 3).map((node) => index.coordinates.get(node));
    const apex = element.nodes.slice(0, 4).find((node) => !nodes.includes(node));
    const d = apex === undefined ? undefined : index.coordinates.get(apex);
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    const e1 = sub3(b, a);
    const e2 = sub3(c, a);
    const raw = cross3(e1, e2);
    const length = Math.hypot(...raw);
    if (!(length > 0)) continue;
    const sign = dot3(raw, sub3(d, a)) > 0 ? -1 : 1;
    faces.push({ a, e1, e2, normal: [(sign * raw[0]) / length, (sign * raw[1]) / length, (sign * raw[2]) / length] });
  }
  return faces;
}

/** Signed distance of `p` to `face` along its outward normal when `p` projects inside the triangle, else null. */
function signedDistance(face: MasterFace, p: Vec3): number | null {
  const w = sub3(p, face.a);
  const s = dot3(w, face.normal);
  const d00 = dot3(face.e1, face.e1);
  const d01 = dot3(face.e1, face.e2);
  const d11 = dot3(face.e2, face.e2);
  const d20 = dot3(w, face.e1);
  const d21 = dot3(w, face.e2);
  const det = d00 * d11 - d01 * d01;
  const v = (d11 * d20 - d01 * d21) / det;
  const u = (d00 * d21 - d01 * d20) / det;
  return v >= -INSIDE_SLACK && u >= -INSIDE_SLACK && u + v <= 1 + INSIDE_SLACK ? s : null;
}

/**
 * Largest initial overclosure of the slave corner nodes of `pair` (analysis length unit): for each node the master face it projects onto
 * with the smallest |distance|; a node behind that face (negative distance) overcloses by -distance.
 * @failure more than MAX_OVERCLOSURE_TESTS node x face tests, or no slave / master faces -> null (not measured)
 */
export function initialOverclosure(
  mesh: FeMeshArtifact,
  pair: ContactPair,
): { readonly value: number; readonly node: number | null } | null {
  const index = indexMesh(mesh);
  const faces = masterFaces(index, mesh, pair);
  const slaveKey = pairTargetKey(pair.id, 'S');
  const slaveNodes = new Set<number>();
  for (const [elementId, label] of Object.hasOwn(mesh.faceSets, slaveKey) ? (mesh.faceSets[slaveKey] ?? []) : []) {
    const element = index.elements.get(elementId);
    for (const node of (element === undefined ? null : faceNodes(element, label))?.slice(0, 3) ?? []) slaveNodes.add(node);
  }
  if (faces.length === 0 || slaveNodes.size === 0 || faces.length * slaveNodes.size > MAX_OVERCLOSURE_TESTS) return null;
  let worst: { value: number; node: number | null } = { value: 0, node: null };
  for (const node of slaveNodes) {
    const p = index.coordinates.get(node);
    if (p === undefined) continue;
    let nearest: number | null = null;
    for (const face of faces) {
      const s = signedDistance(face, p);
      if (s !== null && (nearest === null || Math.abs(s) < Math.abs(nearest))) nearest = s;
    }
    if (nearest !== null && -nearest > worst.value) worst = { value: -nearest, node };
  }
  return worst;
}
