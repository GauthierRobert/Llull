/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'pyramid'` entities.
 * Rectangular base centered at position (±baseWidth/2 in X, ±baseDepth/2 in Y),
 * apex at +Z*height (Z-up, matches core tessellation).
 * Geometry is memoized on geometric fields; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { PyramidEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildPyramidGeometry } from './primitiveGeometry';

export function PyramidMesh({
  entity,
  ...shell
}: SolidMeshKindProps<PyramidEntity>): React.ReactElement {
  const { baseWidth, baseDepth, height } = entity;
  const geometry = useMemo(
    () => buildPyramidGeometry(baseWidth, baseDepth, height),
    [baseWidth, baseDepth, height],
  );
  return <SolidMeshShell entity={entity} geometry={geometry} {...shell} />;
}
