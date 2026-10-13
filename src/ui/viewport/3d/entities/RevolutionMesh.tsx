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
 * @see tessellateRevolution in core/commands/render/renderView.ts (reference tessellation)
 */

import { useMemo } from 'react';
import type { RevolutionEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { pointsKey, useStableByKey } from '../../useStableByKey';
import { buildRevolutionGeometry } from './primitiveGeometry';

function RevolutionSolid({ entity, ...shell }: SolidMeshKindProps<RevolutionEntity>): React.ReactElement {
  const { angle, segments } = entity;
  const profile = useStableByKey(entity.profile, pointsKey(entity.profile));
  const axis = useStableByKey(entity.axis, pointsKey([entity.axis]));

  const geometry = useMemo(() => buildRevolutionGeometry(profile, axis, angle, segments), [profile, axis, angle, segments]);

  return <SolidMeshShell entity={entity} geometry={geometry} doubleSided boundsTree={false} {...shell} />;
}

export function RevolutionMesh(props: SolidMeshKindProps<RevolutionEntity>): React.ReactElement | null {
  if (props.entity.profile.length < 3) return null;
  return <RevolutionSolid {...props} />;
}
