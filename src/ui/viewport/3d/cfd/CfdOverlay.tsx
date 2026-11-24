// Not `captureExclude`: the computed flow is part of the design view, so capture_viewport / render_view frames include it (the editing helpers are the ones left out).
// The Flow panel's slice and streamlines on the model (inside the floating-origin group): a colour-mapped plane patch and speed-coloured
// polylines, drawn from the decoded files in the flow view store. Presentation only: nothing here computes flow or touches the document.

import React, { useMemo } from 'react';
import * as THREE from 'three';
import { toMetres } from '@core/model/units';
import { useStore } from '@ui/store';
import { useFlowViewStore, type SliceLayer, type StreamlinesLayer } from '@ui/store/flowViewStore';
import { useDisposable } from '../../useDisposable';
import { sliceCorners, sliceTexels, streamlineSegments, type ValueRange } from './cfdPaint';

const UNIT_RANGE: ValueRange = { min: 0, max: 1 };
/** The layers are a readout, never a pick target: clicks reach the model behind them. */
const noRaycast = (): void => undefined;

function SliceQuad({ layer, scale }: { layer: SliceLayer; scale: number }): React.ReactElement {
  const { file } = layer;
  const range = useMemo(() => file.range ?? UNIT_RANGE, [file]);
  const texture = useDisposable(() => {
    const made = new THREE.DataTexture(sliceTexels(file, range), file.samples, file.samples, THREE.RGBAFormat);
    made.colorSpace = THREE.SRGBColorSpace;
    made.magFilter = THREE.NearestFilter;
    made.minFilter = THREE.NearestFilter;
    made.needsUpdate = true;
    return made;
  }, [file, range]);
  const geometry = useDisposable(() => {
    const made = new THREE.BufferGeometry();
    made.setAttribute('position', new THREE.BufferAttribute(sliceCorners(file, scale), 3));
    made.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    made.setIndex([0, 1, 2, 0, 2, 3]);
    return made;
  }, [file, scale]);
  const material = useDisposable(
    () =>
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [texture],
  );
  return <mesh name="cfd-slice" geometry={geometry} material={material} renderOrder={5} frustumCulled={false} raycast={noRaycast} />;
}

function Streamlines({ layer, scale }: { layer: StreamlinesLayer; scale: number }): React.ReactElement {
  const { file } = layer;
  const range = useMemo(() => file.range ?? UNIT_RANGE, [file]);
  const geometry = useDisposable(() => {
    const { positions, colors } = streamlineSegments(file, range, scale);
    const made = new THREE.BufferGeometry();
    made.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    made.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return made;
  }, [file, range, scale]);
  const material = useDisposable(() => new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false }), []);
  return (
    <lineSegments
      name="cfd-streamlines"
      geometry={geometry}
      material={material}
      renderOrder={6}
      frustumCulled={false}
      raycast={noRaycast}
    />
  );
}

export function CfdOverlay(): React.ReactElement | null {
  const caseId = useFlowViewStore((s) => s.caseId);
  const showSlice = useFlowViewStore((s) => s.showSlice);
  const showStreamlines = useFlowViewStore((s) => s.showStreamlines);
  const slice = useFlowViewStore((s) => s.slice);
  const streamlines = useFlowViewStore((s) => s.streamlines);
  /** The files are in world metres; the scene is in document units. */
  const scale = useStore((s) => 1 / toMetres({ units: s.document.units }, 1));
  if (caseId === null) return null;
  return (
    <group name="cfd-overlay" userData={{ noEdges: true }}>
      {showSlice && slice.status === 'ready' && <SliceQuad layer={slice.value} scale={scale} />}
      {showStreamlines && streamlines.status === 'ready' && <Streamlines layer={streamlines.value} scale={scale} />}
    </group>
  );
}
