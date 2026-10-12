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
import { buildTriangleSoupGeometry } from './meshSolidGeometry';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';

const LOFT_SURFACE: SolidSurface = { roughness: 0.4, metalness: 0.2, envMapIntensity: 0.9 };

export function LoftMesh({
  entity,
  ...shell
}: SolidMeshKindProps<LoftEntity>): React.ReactElement | null {
  const { rings, ruled } = entity;
  const geometry = useMemo(() => {
    return buildTriangleSoupGeometry(loftTriangles({ rings, ruled }));
  }, [rings, ruled]);

  if (geometry === null) return null;
  return <SolidMeshShell entity={entity} geometry={geometry} surface={LOFT_SURFACE} {...shell} />;
}
