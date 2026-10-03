/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'cylinder'` entities.
 * Geometry is memoized on the entity's geometric fields; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { CylinderEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildCylinderGeometry } from './primitiveGeometry';

export function CylinderMesh({
  entity,
  ...shell
}: SolidMeshKindProps<CylinderEntity>): React.ReactElement {
  const { radius, height } = entity;
  const geometry = useMemo(() => buildCylinderGeometry(radius, height), [radius, height]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}
