/** Floor-fillet support of a lowered pocket (07 FTR §5.5): which edges of the cut result are the pocket floor perimeter. */

import type { FeatureFrame } from '../model/features';
import type { ShapeTopology } from './kernel';
import { heightAbove, worldToFrame } from './featureFrame';
import { distanceToOutline } from './pocketOutline';
import type { PocketTool } from './featureLowering';

/**
 * Indices of the `topology` edges that lie on the floor plane and on the pocket outline (within a small tolerance): matched by geometry,
 * not by index, because the boolean may split the tool's edges.
 */
export function floorEdgeIndices(topology: ShapeTopology, tool: PocketTool, frame: FeatureFrame): number[] {
  const tolerance = 1e-5 * (1 + tool.floorDepth);
  return topology.edges
    .filter((edge) => {
      if (edge.seam || edge.degenerate) return false;
      const points = [edge.start, edge.mid, edge.end];
      const onFloor = points.every((point) => Math.abs(heightAbove(frame, point) + tool.floorDepth) < tolerance);
      return onFloor && points.every((point) => distanceToOutline(tool.outline.curves, worldToFrame(frame, point)) < tolerance);
    })
    .map((edge) => edge.index);
}
