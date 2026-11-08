/** The 05 FEA target: points that identify faces / edges / vertices of an entity; the mesher resolves them to the nearest topology (never ids). */

import type { Vec3 } from './vectors';

export interface FeaTarget {
  /** Id of the analysed entity (structurally `types.ts` `EntityId`, not imported: types.ts imports the analysis model). */
  readonly entityId: string;
  readonly facesNear?: readonly Vec3[];
  readonly edgesNear?: readonly Vec3[];
  readonly pointsNear?: readonly Vec3[];
  readonly intersectPlane?: { readonly point: Vec3; readonly normal: Vec3 };
}
