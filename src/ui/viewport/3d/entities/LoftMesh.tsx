/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'loft'`: the core loft tessellation (geometry/loft.ts, shared with export
 * and the kernels) in the entity's local frame, with creased normals. Memoized on the ring /
 * ruled inputs, which change only when the loft does (pure commands, L3).
 */

import { useMemo } from 'react';
import type { LoftEntity } from '@core/model/types';
import { loftTriangles } from '@core/geometry/loft';
import type { SolidMeshKindProps, SolidSurface } from './SolidMeshShell';
import { TriangleSoupMesh } from './TriangleSoupMesh';

const LOFT_SURFACE: SolidSurface = { roughness: 0.4, metalness: 0.2, envMapIntensity: 0.9 };

export function LoftMesh({ entity, ...shell }: SolidMeshKindProps<LoftEntity>): React.ReactElement {
  const { rings, ruled } = entity;
  const triangles = useMemo(() => loftTriangles({ rings, ruled }), [rings, ruled]);
  return <TriangleSoupMesh entity={entity} triangles={triangles} surface={LOFT_SURFACE} {...shell} />;
}
