// The drag preview: the edited surface as the commit would store it, drawn as a translucent hologram over the real entity.

import * as THREE from 'three';
import { buildTriangleSoupGeometry } from '../entities/meshSolidGeometry';
import type { CagePreviewState } from '@ui/store/directEditStore';
import { useDisposable } from '../../useDisposable';
import { CAGE_COLORS } from './cagePalette';

export function CageGhost({ preview }: { preview: CagePreviewState }): React.ReactElement | null {
  const geometry = useDisposable(() => {
    const built = buildTriangleSoupGeometry(preview.triangles);
    return built ?? new THREE.BufferGeometry();
  }, [preview.triangles]);
  const material = useDisposable(
    () => new THREE.MeshStandardMaterial({ color: CAGE_COLORS.ghost, transparent: true, opacity: 0.5, roughness: 0.5, depthWrite: false }),
    [],
  );
  return preview.ok ? <mesh geometry={geometry} material={material} renderOrder={5} raycast={() => null} /> : null;
}
