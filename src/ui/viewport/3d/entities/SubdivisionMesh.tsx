/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'subdivision'`: the core Catmull-Clark surface (geometry/subdivision.ts,
 * shared with export and the kernels) in the entity's local frame, with creased normals so sharp
 * cage creases stay hard. Memoized on the cage, which changes only when the solid does (L3).
 */

import { useMemo } from 'react';
import type { SubdivisionEntity } from '@core/model/types';
import { subdivisionTriangles } from '@core/geometry/subdivision';
import { buildTriangleSoupGeometry } from './meshSolidGeometry';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';

const SUBDIVISION_SURFACE: SolidSurface = { roughness: 0.45, metalness: 0.1, envMapIntensity: 0.9 };

export function SubdivisionMesh({
  entity,
  ...shell
}: SolidMeshKindProps<SubdivisionEntity>): React.ReactElement | null {
  const { vertices, faces, creases, levels } = entity;
  const geometry = useMemo(() => {
    return buildTriangleSoupGeometry(subdivisionTriangles({ vertices, faces, creases, levels }));
  }, [vertices, faces, creases, levels]);

  if (geometry === null) return null;
  return (
    <SolidMeshShell entity={entity} geometry={geometry} surface={SUBDIVISION_SURFACE} {...shell} />
  );
}
