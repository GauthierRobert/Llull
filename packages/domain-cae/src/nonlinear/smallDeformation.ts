/** Small-deformation guardrail of a nlgeom-false case: a rotation estimate from the displacement field (llull rule, named in the finding). */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { magnitude, maxOverNodes } from '../results/fields';

/**
 * Estimated largest rotation in radians: atan(largest displacement magnitude over every stored increment / largest extent of the mesh bounding box). The
 * displacement field of solids carries no rotations, so this is a bound-free estimate (a rigid rotation of a part of that size), not a measurement.
 * @failure no displacement field or an empty mesh -> null
 */
export function estimatedRotation(mesh: FeMeshArtifact, results: FeResultsArtifact): number | null {
  const peak = results.steps.reduce((best, step) => {
    const found = maxOverNodes(step.fields['DISP'], magnitude);
    return found === null ? best : Math.max(best, found.value);
  }, 0);
  if (mesh.nodes.length === 0 || peak === 0) return null;
  const extent = [1, 2, 3].reduce((best, axis) => {
    const values = mesh.nodes.map((node) => node[axis] ?? 0);
    return Math.max(best, Math.max(...values) - Math.min(...values));
  }, 0);
  return extent > 0 ? Math.atan(peak / extent) : null;
}
