/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'torus'` entities.
 * Ring lies in the XY plane (hole faces +Z), centered on position (Z-up, matches core tessellation).
 * Geometry is memoized on the entity's geometric fields; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { TorusEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';
import { buildTorusGeometry } from './primitiveGeometry';

const TORUS_SURFACE: SolidSurface = { roughness: 0.4, metalness: 0.1, envMapIntensity: 0.9 };

export function TorusMesh({
  entity,
  ...shell
}: SolidMeshKindProps<TorusEntity>): React.ReactElement {
  const { ringRadius, tubeRadius } = entity;
  const geometry = useMemo(
    () => buildTorusGeometry(ringRadius, tubeRadius),
    [ringRadius, tubeRadius],
  );
  return <SolidMeshShell entity={entity} geometry={geometry} surface={TORUS_SURFACE} {...shell} />;
}
