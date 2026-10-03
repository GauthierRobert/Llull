/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'box'` entities.
 * Geometry is memoized on the entity's size fields; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { BoxEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';

export function BoxMesh({ entity, ...shell }: SolidMeshKindProps<BoxEntity>): React.ReactElement {
  const [sx, sy, sz] = entity.size;
  const geometry = useMemo(() => new THREE.BoxGeometry(sx, sy, sz), [sx, sy, sz]);
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}
