/**
 * @layer ui/viewport/3d
 *
 * Render branch for `kind:'mesh'` entities — boolean-operation results stored as
 * arbitrary triangle meshes. `MeshSolidEntity.mesh` holds world-space geometry;
 * `position` and `rotation` are [0,0,0] for results produced by the boolean commands,
 * but are honored here so the entity remains gizmo-transformable (TransformControls).
 *
 * Geometry is built in `useMemo` keyed on the mesh data reference — rebuilt only when the
 * mesh itself changes; lifecycle handled by SolidMeshShell.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { MeshSolidEntity } from '@core/model/types';
import { positionsGeometry } from '../../lineGeometry';
import { SolidMeshShell, type SolidMeshKindProps, type SolidSurface } from './SolidMeshShell';

const MESH_SOLID_SURFACE: SolidSurface = { roughness: 0.5, metalness: 0.15, envMapIntensity: 0.8 };

export function MeshSolidMesh({
  entity,
  ...shell
}: SolidMeshKindProps<MeshSolidEntity>): React.ReactElement {
  const { mesh } = entity;

  const geometry = useMemo(() => {
    const geo = positionsGeometry(mesh.positions);
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.indices), 1));
    // Mesh stores no normals; derive them for correct lighting.
    geo.computeVertexNormals();
    return geo;
  }, [mesh]);

  return (
    <SolidMeshShell entity={entity} geometry={geometry} surface={MESH_SOLID_SURFACE} {...shell} />
  );
}
