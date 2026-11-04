// Scan point clouds as THREE.Points, one object per resident tile (positions relative to the tile origin, colour per point). Inside the
// floating-origin group, so tiles are placed in document coordinates. The data is streamed by `useCloudStreaming`; the section plane of
// ClippingPlane already applies (renderer clipping planes cut every material). Presentation only: the document is read, never written.

import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { useScanViewStore } from '@ui/store/scanViewStore';
import { useDisposable } from '../useDisposable';
import { cropsFor, type CropLike } from './scan/cropFilter';
import { applyEdl, createEdlUniforms, type EdlUniforms } from './scan/edlShading';
import { EDL_LAYER, EdlPass } from './scan/EdlPass';
import { useCloudStreaming, type DrawnTile } from './scan/useCloudStreaming';
import type { ColourMode } from './scan/colourModes';
import type { CloudReference, CropBox } from './scan/cloudTypes';

const RENDER_ORDER = 5;
const MIN_POINT_PX = 1;
const MAX_POINT_PX = 8;

function TilePoints({ tile, material }: { tile: DrawnTile; material: THREE.PointsMaterial }): React.ReactElement {
  const geometry = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tile.buffers.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(tile.buffers.colours, 3));
    g.computeBoundingSphere();
    return g;
  }, [tile.buffers]);
  const joinEdlLayer = (points: THREE.Points | null): void => points?.layers.enable(EDL_LAYER);
  return <points ref={joinEdlLayer} geometry={geometry} material={material} position={tile.buffers.origin} renderOrder={RENDER_ORDER} />;
}

function CloudLayer({ cloud, crops, edl }: { cloud: CloudReference; crops: readonly CropLike[]; edl: EdlUniforms }): React.ReactElement {
  const choice = useScanViewStore((s) => s.colourChoice);
  const mode: ColourMode = choice === 'document' ? cloud.display.colorBy : choice;
  const drawn = useCloudStreaming({ id: cloud.id, mode, crops });
  const pointSize = Math.min(MAX_POINT_PX, Math.max(MIN_POINT_PX, cloud.display.pointSize));
  const material = useDisposable(() => {
    const m = new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: false, vertexColors: true });
    applyEdl(m, edl);
    return m;
  }, [pointSize, edl]);
  useEffect(() => {
    edl.edlPointSize.value = pointSize;
  }, [edl, pointSize]);
  return (
    <group name={`point-cloud-${cloud.id}`}>
      {drawn.map((tile) => (
        <TilePoints key={tile.key} tile={tile} material={material} />
      ))}
    </group>
  );
}

export function PointClouds(): React.ReactElement | null {
  const scan = useStore((s) => s.document.scan);
  const applyCrops = useScanViewStore((s) => s.applyCrops);
  const edlOn = useScanViewStore((s) => s.edl);
  const edl = useMemo(createEdlUniforms, []);
  const allCrops = useMemo<readonly CropBox[]>(() => (scan === undefined ? [] : Object.values(scan.crops)), [scan]);
  if (scan === undefined) return null;
  const visible = scan.cloudOrder.flatMap((id) => {
    const cloud = scan.clouds[id];
    return cloud !== undefined && cloud.display.visible ? [cloud] : [];
  });
  return (
    <>
      {edlOn && visible.length > 0 && <EdlPass uniforms={edl} />}
      {visible.map((cloud) => (
        <CropAwareLayer key={cloud.id} cloud={cloud} crops={allCrops} applyCrops={applyCrops} edl={edl} />
      ))}
    </>
  );
}

/** Keeps the crop list identity stable per cloud so unchanged crops never rebuild the buffers. */
function CropAwareLayer({
  cloud,
  crops,
  applyCrops,
  edl,
}: {
  cloud: CloudReference;
  crops: readonly CropBox[];
  applyCrops: boolean;
  edl: EdlUniforms;
}): React.ReactElement {
  const applicable = useMemo(() => (applyCrops ? cropsFor(crops, cloud.id) : []), [applyCrops, crops, cloud.id]);
  const online = useStore((s) => s.liveStatus === 'connected');
  // A new asset, placement or backend state remounts the layer: the streamed tiles belong to one (asset, transform).
  const sourceKey = `${cloud.assetKey}|${cloud.transform.join(',')}|${online}`;
  return <CloudLayer key={sourceKey} cloud={cloud} crops={applicable} edl={edl} />;
}
