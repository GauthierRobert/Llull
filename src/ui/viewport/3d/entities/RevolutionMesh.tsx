/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'revolution'` entities.
 *
 * Builds geometry with buildRevolutionGeometry (primitiveGeometry.ts), which uses the same
 * sweep convention as core tessellation/export (start +X, counter-clockwise, dominant-axis frame).
 * Geometry is memoized on (profileKey, axis, angle, segments); lifecycle handled by
 * SolidMeshShell (double-sided, no BVH).
 *
 * @see RevolutionEntity in core/model/types.ts
 * @see tessellateRevolution in core/commands/render.ts (reference tessellation)
 */

import { useMemo } from 'react';
import type { RevolutionEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildRevolutionGeometry } from './primitiveGeometry';

/** Stable string key for the profile array (used as useMemo dep). */
function profileKey(profile: RevolutionEntity['profile']): string {
  return profile.map(([r, a]) => `${r},${a}`).join(';');
}

/** Stable string key for a Vec3 axis (used as useMemo dep). */
function axisKey(axis: RevolutionEntity['axis']): string {
  return `${axis[0]},${axis[1]},${axis[2]}`;
}

function RevolutionSolid({
  entity,
  ...shell
}: SolidMeshKindProps<RevolutionEntity>): React.ReactElement {
  const { profile, axis, angle, segments } = entity;
  const pKey = profileKey(profile);
  const aKey = axisKey(axis);

  const geometry = useMemo(
    () => buildRevolutionGeometry(profile, axis, angle, segments),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pKey, aKey, angle, segments],
  );

  return (
    <SolidMeshShell entity={entity} geometry={geometry} doubleSided boundsTree={false} {...shell} />
  );
}

export function RevolutionMesh(
  props: SolidMeshKindProps<RevolutionEntity>,
): React.ReactElement | null {
  if (props.entity.profile.length < 3) return null;
  return <RevolutionSolid {...props} />;
}
