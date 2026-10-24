/** Predicted volume of a deformed body (01 DEF §5.10): ∫ det J dV over the source, by the method that suits the law. */

import type { MeshData } from '../../model/types';
import type { DeformNode } from './laws';
import { type PredictedVolume, predictedVolume } from './predictedVolume';
import { predictedLocalVolume } from './predictedLocal';
import { predictedVolumeByQuadrature } from './predictedQuadrature';

/**
 * Cross-section integral for the laws driven by the axis (twist, taper, stretch, bend, flow along a curve) and the affine map, divergence-theorem boundary
 * integral for the local ones (point push, lattice), tetrahedral quadrature for the flow onto a surface.
 * @failure degenerate frame, empty mesh, a refinement above the triangle cap -> null
 */
export function predictedVolumeOf(source: MeshData, node: Pick<DeformNode, 'law' | 'frame' | 'region'>): PredictedVolume | null {
  const { kind } = node.law;
  if (kind === 'lattice' || kind === 'point') return predictedLocalVolume(source, node);
  return kind === 'flowSurface' || kind === 'rbf' ? predictedVolumeByQuadrature(source, node) : predictedVolume(source, node);
}
