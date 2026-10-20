// Render branch for `kind:'nurbs_surface'`: the exact patch sampled per knot span (clipped to its trim loops), drawn as a double-sided sheet (no
// volume); with a surface map on (Gaussian / mean curvature, zebra stripes, draft) the vertices carry the analysis colours.

import { useMemo } from 'react';
import type { NurbsSurfaceEntity } from '@core/model/types';
import { tessellateSheet } from '@core/geometry/nurbsSurface';
import { surfaceMapColors } from '@core/geometry/surfaceAnalysis/overlay';
import { useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';
import { SolidMeshShell, type SolidMeshKindProps } from './SolidMeshShell';
import { buildMeshSolidGeometry } from './meshSolidGeometry';

export function NurbsSurfaceMesh({ entity, ...shell }: SolidMeshKindProps<NurbsSurfaceEntity>): React.ReactElement {
  const { surface, trims } = entity;
  const map = useSurfaceOverlayStore((s) => s.map);
  const direction = useSurfaceOverlayStore((s) => s.direction);
  // `surface` is a new reference only when the patch changes (pure commands, L3).
  const geometry = useMemo(() => {
    const { positions, indices, uvs } = tessellateSheet(surface, trims, 10);
    if (map === 'off') return buildMeshSolidGeometry({ positions, indices });
    const pairs = Array.from({ length: uvs.length / 2 }, (_, k) => [uvs[2 * k] as number, uvs[2 * k + 1] as number] as const);
    return buildMeshSolidGeometry({ positions, indices }, surfaceMapColors(surface, pairs, map, { direction }));
  }, [surface, trims, map, direction]);
  return <SolidMeshShell entity={entity} geometry={geometry} doubleSided vertexColors={map !== 'off'} {...shell} />;
}
