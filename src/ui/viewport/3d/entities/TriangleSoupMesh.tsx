/**
 * @layer ui/viewport/3d
 *
 * Shared render branch of the triangle-soup solid kinds (loft, sweep, subdivision): the core
 * tessellation (`triangles`, memoized by the caller) becomes a creased-normal geometry rendered
 * through the common solid shell. Renders nothing for an empty tessellation.
 */

import { useMemo } from 'react';
import type { Triangle } from '@core/geometry/triangles';
import { buildTriangleSoupGeometry } from './meshSolidGeometry';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';
import type { BaseEntity } from '@core/model/types';

interface TriangleSoupMeshProps<E extends BaseEntity> extends SolidMeshKindProps<E> {
  /** Tessellation in the entity's local frame; must be referentially stable between renders. */
  triangles: readonly Triangle[];
  surface: SolidSurface;
}

export function TriangleSoupMesh<E extends BaseEntity>({ triangles, ...shell }: TriangleSoupMeshProps<E>): React.ReactElement | null {
  const geometry = useMemo(() => buildTriangleSoupGeometry(triangles), [triangles]);
  if (geometry === null) return null;
  return <SolidMeshShell geometry={geometry} {...shell} />;
}
