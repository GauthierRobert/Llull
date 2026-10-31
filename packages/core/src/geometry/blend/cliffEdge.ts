/**
 * The cliff edge of a `fillet_faces` cliff blend (TECHNICAL_SPEC 13.28): the straight edge where the blend face meets a face that is none of its
 * supports (the support A was consumed, so the ball touches this edge instead of being tangent to a face). Read back from the kernel's edge continuity.
 * @invariant only a blend face with exactly one of its two supports left is read (the other is the consumed cliff face); pure over a kernel's answers; angles in radians (0 = tangent); end-wall arcs of the blend are not cliff edges (only straight edges count)
 */

import type { GeometryKernel, ShapeTopology } from '../kernel';
import type { FaceGraph } from '../kernelPorts';
import type { ShapeHandle } from '../kernelTypes';
import { blendSource } from './continuity';

export interface CliffEdge {
  /** Unique-edge index of the cliff edge. */
  readonly edge: number;
  /** The face beyond the cliff edge. */
  readonly beyond: number;
  /** Largest angle between the blend's and that face's outward normals along the edge (radians). */
  readonly angleRad: number;
}

/** The cliff edge of blend face `face`, or null when it has none (a plain tangent blend), or the kernel cannot measure it. */
export function cliffEdgeOf(
  kernel: GeometryKernel,
  shape: ShapeHandle,
  topology: ShapeTopology,
  graph: FaceGraph,
  face: number,
  samples = 5,
): CliffEdge | null {
  const name = topology.faces[face]?.name;
  const source = name === undefined ? null : blendSource(name);
  if (source === null) return null;
  const present = new Set(topology.faces.map((candidate) => candidate.name));
  if (source.supports.filter((support) => present.has(support)).length !== 1) return null;
  for (const [edge, around] of graph.edgeFaces.entries()) {
    if (around.length !== 2 || !around.includes(face) || topology.edges[edge]?.curve !== 'line') continue;
    const beyond = around.find((other) => other !== face) ?? -1;
    const otherName = topology.faces[beyond]?.name;
    if (otherName === undefined || source.supports.includes(otherName)) continue;
    const measured = kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null;
    if (measured === null || measured.length === 0) continue;
    return { edge, beyond, angleRad: Math.max(...measured.map((sample) => sample.g1)) };
  }
  return null;
}
