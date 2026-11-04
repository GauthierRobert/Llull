// Pipe-content markers: one instanced arrow per placement of the read-only `pipe_markers` query (field colour of the run's rule), plus the
// rule's marker letters as a billboard on the middle of each lettered run. Recomputed when the document changes (never on selection);
// inside the floating-origin group; toggled in the review Display section (usePipeMarkerStore).

import React, { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Billboard, Text } from '@react-three/drei';
import * as THREE from 'three';
import { MM_PER_UNIT } from '@core/model/units';
import { useDocumentWithoutSelection } from '@ui/store/useDocumentWithoutSelection';
import { usePipeMarkerStore } from '@ui/store/pipeMarkerStore';
import { runQuery } from '@ui/services/localQuery';
import { useDisposable } from '../../useDisposable';
import { markerMatrices, parsePipeMarkers, MARKER_LENGTH_MM } from './pipeMarkerData';

const RENDER_ORDER = 997;

function MarkerArrows({ scene, mmPerUnit }: { scene: ReturnType<typeof parsePipeMarkers>; mmPerUnit: number }): React.ReactElement {
  const count = scene.markers.length;
  // Unit arrow along +Y (base at the origin, tip at y = 1).
  const geometry = useDisposable(() => new THREE.ConeGeometry(0.28, 1, 10).translate(0, 0.5, 0), []);
  const material = useDisposable(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }), []);
  const mesh = useMemo(() => new THREE.InstancedMesh(geometry, material, count), [geometry, material, count]);
  useEffect(() => {
    mesh.instanceMatrix.array.set(markerMatrices(scene.markers, mmPerUnit));
    mesh.instanceMatrix.needsUpdate = true;
    const colour = new THREE.Color();
    scene.markers.forEach((marker, index) => mesh.setColorAt(index, colour.set(marker.colour)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [mesh, scene, mmPerUnit]);
  useEffect(() => () => mesh.dispose(), [mesh]);
  return <primitive object={mesh} name="pipe-marker-arrows" renderOrder={RENDER_ORDER} frustumCulled={false} />;
}

export function PipeMarkerOverlay(): React.ReactElement | null {
  const document = useDocumentWithoutSelection();
  const shown = usePipeMarkerStore((s) => s.shown);
  const invalidate = useThree((state) => state.invalidate);
  const hasPipes = document.building !== undefined || document.plant?.piping !== undefined;
  const scene = useMemo(
    () => (shown && hasPipes ? parsePipeMarkers(runQuery('pipe_markers').data) : { markers: [], labels: [] }),
    // `document` drives the recomputation: the query reads it from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, hasPipes, document],
  );
  useEffect(() => invalidate(), [scene, invalidate]);
  if (scene.markers.length === 0) return null;
  const mmPerUnit = MM_PER_UNIT[document.units];
  const lift = (MARKER_LENGTH_MM * 0.8) / mmPerUnit;
  return (
    <group name="pipe-markers">
      <MarkerArrows scene={scene} mmPerUnit={mmPerUnit} />
      {scene.labels.map((label) => (
        <Billboard
          key={label.runId}
          position={[label.positionMm[0] / mmPerUnit, label.positionMm[1] / mmPerUnit, label.positionMm[2] / mmPerUnit + lift]}
        >
          <Text fontSize={lift} color={label.colour} outlineWidth={lift * 0.08} outlineColor="#0b1220" renderOrder={RENDER_ORDER + 1}>
            {label.letters}
          </Text>
        </Billboard>
      ))}
    </group>
  );
}
