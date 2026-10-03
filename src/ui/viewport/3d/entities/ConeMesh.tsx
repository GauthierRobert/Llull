/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'cone'` entities.
 * Apex at +Z*height, base centered on position (Z-up, matches core tessellation).
 * Geometry is memoized on the entity's geometric fields; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { ConeEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildConeGeometry } from './primitiveGeometry';

export function ConeMesh({ entity, ...shell }: SolidMeshKindProps<ConeEntity>): React.ReactElement {
  const { radius, height } = entity;
  const geometry = useMemo(() => buildConeGeometry(radius, height), [radius, height]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}
