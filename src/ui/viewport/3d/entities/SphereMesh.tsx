/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'sphere'` entities.
 * Geometry is memoized on the entity's radius; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { SphereEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';
import { buildSphereGeometry } from './primitiveGeometry';

const SPHERE_SURFACE: SolidSurface = { roughness: 0.35, metalness: 0.12, envMapIntensity: 1.0 };

export function SphereMesh({
  entity,
  ...shell
}: SolidMeshKindProps<SphereEntity>): React.ReactElement {
  const { radius } = entity;
  const geometry = useMemo(() => buildSphereGeometry(radius), [radius]);
  return <SolidMeshShell entity={entity} geometry={geometry} surface={SPHERE_SURFACE} {...shell} />;
}
