// Render branch for `kind:'nurbs_surface'`: the exact patch sampled per knot span, drawn as a double-sided sheet (no volume).

import { useMemo } from 'react';
import type { NurbsSurfaceEntity } from '@core/model/types';
import { tessellateSurface } from '@core/geometry/nurbsSurface';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildMeshSolidGeometry } from './meshSolidGeometry';

export function NurbsSurfaceMesh({ entity, ...shell }: SolidMeshKindProps<NurbsSurfaceEntity>): React.ReactElement {
  const { surface } = entity;
  // `surface` is a new reference only when the patch changes (pure commands, L3).
  const geometry = useMemo(() => {
    const { positions, indices } = tessellateSurface(surface, 10);
    return buildMeshSolidGeometry({ positions, indices });
  }, [surface]);
  return <SolidMeshShell entity={entity} geometry={geometry} doubleSided {...shell} />;
}
