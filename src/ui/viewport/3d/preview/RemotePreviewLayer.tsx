// In-Canvas ghost of the backend dry run of a drag (`POST /preview`): the entities the command would produce, as translucent hologram meshes.
// Not pickable, no shadows; the replaced entities fade through the ghost store. Positions are world space (mounted in the floating-origin group).

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useRemotePreviewStore, type PreviewMesh } from '@ui/store/remotePreviewStore';
import { useDisposable } from '../../useDisposable';
import { previewGeometry } from './previewGeometry';

const GHOST_COLOR = '#3b82f6';

function PreviewMeshObject({ mesh, material }: { mesh: PreviewMesh; material: THREE.Material }): React.ReactElement {
  const anchored = useDisposable(() => {
    const built = previewGeometry(mesh);
    return { ...built, dispose: () => built.geometry.dispose() };
  }, [mesh]);
  return <mesh geometry={anchored.geometry} material={material} position={[...anchored.anchor]} renderOrder={6} raycast={() => null} />;
}

export function RemotePreviewLayer(): React.ReactElement | null {
  const meshes = useRemotePreviewStore((s) => s.meshes);
  const invalidate = useThree((s) => s.invalidate);
  const material = useDisposable(
    () =>
      new THREE.MeshStandardMaterial({
        color: GHOST_COLOR,
        emissive: GHOST_COLOR,
        emissiveIntensity: 0.18,
        transparent: true,
        opacity: 0.5,
        roughness: 0.55,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );
  useEffect(() => invalidate(), [meshes, invalidate]);
  if (meshes.length === 0) return null;
  return (
    <group name="remote-preview">
      {meshes.map((mesh) => (
        <PreviewMeshObject key={mesh.id} mesh={mesh} material={material} />
      ))}
    </group>
  );
}
