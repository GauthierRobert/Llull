// Scan-point snap for a dragged handle: the cloud point nearest, on screen, to where the handle is drawn. Thin adapter over the pure
// `nearestScreenPoint`: it only reads the camera and the resident tiles.

import * as THREE from 'three';
import type { Vec3 } from '@core/model/vectors';
import { nearestScreenPoint, projectToScreen, type SnapView } from './pointSnap';
import { allSnapTiles } from './snapRegistry';

/** Snap radius in px (a handle within a thumb-width of a scan point locks onto it). */
const SCAN_SNAP_TOLERANCE_PX = 12;
const FOV_FALLBACK = 1;

const scratch = new THREE.Matrix4();

function snapViewOf(camera: THREE.Camera, size: { readonly width: number; readonly height: number }, renderOrigin: Vec3): SnapView {
  camera.updateMatrixWorld();
  scratch.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const fov = camera instanceof THREE.PerspectiveCamera ? (camera.fov * Math.PI) / 180 : FOV_FALLBACK;
  return {
    viewProjection: [...scratch.elements],
    renderOrigin,
    width: size.width,
    height: size.height,
    focalPx: size.height / (2 * Math.tan(fov / 2)),
  };
}

/** The scan point to snap the document position `target` to, or null (nothing resident near it on screen, or snap off). */
export function scanSnapFor(
  target: Vec3,
  camera: THREE.Camera,
  size: { readonly width: number; readonly height: number },
  renderOrigin: Vec3,
): Vec3 | null {
  const tiles = allSnapTiles();
  if (tiles.length === 0) return null;
  const view = snapViewOf(camera, size, renderOrigin);
  const pointer = projectToScreen(view, target[0], target[1], target[2]);
  if (pointer === null) return null;
  return nearestScreenPoint(tiles, view, pointer, SCAN_SNAP_TOLERANCE_PX)?.position ?? null;
}
