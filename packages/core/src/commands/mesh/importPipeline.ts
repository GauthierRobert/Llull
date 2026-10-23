/** The unit conversion and weld every mesh import applies, shared by `import_mesh_file` and the host tool `mesh_import` (07 MSH FR-MSH-01/02). */

import { meshDiagonal, weldMesh } from '../../geometry/mesh/weld';
import type { MeshData } from '../../model/types';
import type { DocumentUnit } from '../../model/types';
import { MM_PER_UNIT } from '../../model/units';
import { WELD_TOLERANCE_FRACTION } from './meshCommon';

/** File unit -> document unit factor; null when the file has no unit of its own and none was given. */
export function importUnitScale(
  unitMetres: number | undefined,
  units: DocumentUnit | undefined,
  documentUnits: DocumentUnit,
): number | null {
  if (units !== undefined) return MM_PER_UNIT[units] / MM_PER_UNIT[documentUnits];
  if (unitMetres === undefined) return null;
  return (unitMetres * 1000) / MM_PER_UNIT[documentUnits];
}

export interface WeldedBody {
  readonly mesh: MeshData;
  readonly mergedVertices: number;
  /** The tolerance used (document units). */
  readonly tolerance: number;
  readonly defaulted: boolean;
}

/** One file body scaled to document units and welded (default tolerance 1e-6 x bounding-box diagonal). */
export function scaleAndWeld(
  positions: ReadonlyArray<number>,
  triangles: ReadonlyArray<number>,
  unitScale: number,
  weldTolerance?: number,
): WeldedBody {
  const scaled = positions.map((value) => value * unitScale);
  const tolerance = weldTolerance ?? WELD_TOLERANCE_FRACTION * meshDiagonal(scaled);
  const welded = weldMesh({ positions: scaled, indices: [...triangles] }, tolerance);
  return {
    mesh: { positions: welded.positions, indices: welded.triangles },
    mergedVertices: welded.mergedVertices,
    tolerance,
    defaulted: weldTolerance === undefined,
  };
}
