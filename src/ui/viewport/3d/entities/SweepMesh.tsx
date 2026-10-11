/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'sweep'`: the core sweep tessellation (geometry/sweep.ts, the same
 * triangles export and the kernels use) built in the entity's local frame, with creased normals
 * so pipe walls shade smooth and end caps stay flat. Memoized on the path/section references,
 * which change only when the sweep does (pure commands, L3).
 */

import { useMemo } from 'react';
import type { SweepEntity } from '@core/model/types';
import { sweepTriangles } from '@core/geometry/sweep';
import { buildMeshSolidGeometry } from './meshSolidGeometry';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';

const SWEEP_SURFACE: SolidSurface = { roughness: 0.4, metalness: 0.3, envMapIntensity: 0.9 };

export function SweepMesh({
  entity,
  ...shell
}: SolidMeshKindProps<SweepEntity>): React.ReactElement | null {
  const { path, section } = entity;
  const geometry = useMemo(() => {
    const positions = sweepTriangles(path, section).flat(2);
    if (positions.length === 0) return null;
    const indices = Array.from({ length: positions.length / 3 }, (_, corner) => corner);
    return buildMeshSolidGeometry({ positions, indices });
  }, [path, section]);

  if (geometry === null) return null;
  return <SolidMeshShell entity={entity} geometry={geometry} surface={SWEEP_SURFACE} {...shell} />;
}
