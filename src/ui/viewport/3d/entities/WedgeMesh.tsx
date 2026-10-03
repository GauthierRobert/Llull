/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'wedge'` entities.
 * A right-triangular prism (ramp): full height at the front face (z=0),
 * tapering to zero height at the back face (z=depth).
 * `size` = [width(X), height(Y), depth(Z)]; `position` is the lower-front-left corner.
 * Lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import type { WedgeEntity } from '@core/model/types';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';
import { buildWedgeGeometry } from './primitiveGeometry';

const WEDGE_SURFACE: SolidSurface = { roughness: 0.5, metalness: 0.08, envMapIntensity: 0.8 };

export function WedgeMesh({
  entity,
  ...shell
}: SolidMeshKindProps<WedgeEntity>): React.ReactElement {
  const [w, h, d] = entity.size;
  const geometry = useMemo(() => buildWedgeGeometry(w, h, d), [w, h, d]);
  return <SolidMeshShell entity={entity} geometry={geometry} surface={WEDGE_SURFACE} {...shell} />;
}
