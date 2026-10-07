/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'extrusion'` entities.
 * Builds a THREE.ExtrudeGeometry from the 2D profile; memoized on profile + depth.
 * Lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { ExtrusionEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { useStableByKey } from '../../useStableByKey';

/** Stable serialization key for the profile array. */
function profileKey(profile: ExtrusionEntity['profile']): string {
  return profile.map(([x, y]) => `${x},${y}`).join(';');
}

export function ExtrusionMesh({
  entity,
  ...shell
}: SolidMeshKindProps<ExtrusionEntity>): React.ReactElement {
  const { depth } = entity;

  // Rebuild geometry only when the profile points or depth change.
  const profile = useStableByKey(entity.profile, profileKey(entity.profile));

  const geometry = useMemo(() => {
    const first = profile[0];
    if (!first) return new THREE.BufferGeometry();
    const shape = new THREE.Shape();
    shape.moveTo(first[0], first[1]);
    for (let i = 1; i < profile.length; i++) {
      const pt = profile[i];
      if (pt) shape.lineTo(pt[0], pt[1]);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  }, [profile, depth]);

  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}
