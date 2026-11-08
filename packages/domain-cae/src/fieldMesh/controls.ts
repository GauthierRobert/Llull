/** The mesh controls a field-meshed case (14 FLL-M1, source implicit_field) admits: a uniform lattice, each body on its own. */

import type { MeshControls } from '@core/model/analysis';

/** Why `mesh` cannot be meshed from a field, or null. */
export function implicitFieldConflict(mesh: MeshControls): string | null {
  if (mesh.source !== 'implicit_field') return null;
  if (mesh.refinements.length > 0)
    return `source implicit_field meshes a uniform lattice: remove the ${mesh.refinements.length} refinement(s) (refinements: []) or use source geometry`;
  if (mesh.bonding === 'conformal') return 'source implicit_field meshes each body on its own: use bonding separate or source geometry';
  return null;
}
