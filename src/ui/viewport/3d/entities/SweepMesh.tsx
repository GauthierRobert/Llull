/**
 * Render branch for `kind:'sweep'`: the core sweep tessellation (geometry/sweep.ts, the same
 * triangles export and the kernels use) built in the entity's local frame, with creased normals
 * so pipe walls shade smooth and end caps stay flat. Memoized on the path/section references,
 * which change only when the sweep does (pure commands, L3).
 */

import { useMemo } from 'react';
import type { SweepEntity } from '@core/model/types';
import { sweepTriangles } from '@core/geometry/sweep';
import type { SolidMeshKindProps, SolidSurface } from './SolidMeshShell';
import { TriangleSoupMesh } from './TriangleSoupMesh';

const SWEEP_SURFACE: SolidSurface = { roughness: 0.4, metalness: 0.3, envMapIntensity: 0.9 };

export function SweepMesh({ entity, ...shell }: SolidMeshKindProps<SweepEntity>): React.ReactElement {
  const { path, section, stations } = entity;
  const triangles = useMemo(
    () => sweepTriangles(stations === undefined ? { path, section } : { path, section, stations }),
    [path, section, stations],
  );
  return <TriangleSoupMesh entity={entity} triangles={triangles} surface={SWEEP_SURFACE} {...shell} />;
}
