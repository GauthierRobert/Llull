// In-Canvas capture hook (ASC M6a, D6): draws the current scene into an offscreen render target with a TEMPORARY camera and encodes it as PNG.
// The user's camera, the document, every store and the on-screen frame are not touched: `hideLayers` is a mask on the scene applied and undone inside
// ONE synchronous draw (`frameMask.ts`), so no React frame can show it and the user's own layer filter is never written.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { VIEWPORT_FOV_DEGREES } from '@core/model/viewport';
import type { ViewportCaptureRequest } from '@core/model/viewportCapture';
import { useStore, useViewportStore } from '@ui/store';
import { applyFrameMask } from './frameMask';
import { capturePose } from './capturePose';
import { setViewportCapturer, type CapturedPng } from './captureRegistry';

const NEAR_RATIO = 1 / 2000;
const FAR_RATIO = 2000;

async function pngOf(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const flipped = new Uint8ClampedArray(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) flipped.set(rgba.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2D canvas to encode the frame');
  context.putImageData(new ImageData(flipped, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('PNG encoding failed');
  return new Uint8Array(await blob.arrayBuffer());
}

function drawFrame(gl: THREE.WebGLRenderer, scene: THREE.Scene, request: ViewportCaptureRequest): Uint8Array {
  const { width, height } = request;
  const limit = gl.capabilities.maxTextureSize;
  if (width > limit || height > limit) throw new Error(`the GPU draws at most ${limit} pixels per side`);
  const { document: doc, renderOrigin: origin } = useStore.getState();
  const { hiddenLayerIds, hiddenEntityIds } = useViewportStore.getState();
  const pose = capturePose(request, doc, hiddenLayerIds, hiddenEntityIds);
  const camera = new THREE.PerspectiveCamera(VIEWPORT_FOV_DEGREES, width / height, pose.distance * NEAR_RATIO, pose.distance * FAR_RATIO);
  camera.up.set(...pose.up);
  camera.position.set(pose.position[0] - origin[0], pose.position[1] - origin[1], pose.position[2] - origin[2]);
  camera.lookAt(pose.target[0] - origin[0], pose.target[1] - origin[1], pose.target[2] - origin[2]);
  camera.updateMatrixWorld();
  const target = new THREE.WebGLRenderTarget(width, height, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const previousTarget = gl.getRenderTarget();
  const previousBackground = scene.background;
  const unmask = applyFrameMask(scene, doc, new Set(request.hideLayers));
  try {
    if (request.background !== undefined) scene.background = new THREE.Color(request.background);
    gl.setRenderTarget(target);
    gl.clear();
    gl.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    gl.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return pixels;
  } finally {
    unmask();
    scene.background = previousBackground;
    gl.setRenderTarget(previousTarget);
    target.dispose();
  }
}

export function CaptureRig(): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    setViewportCapturer(async (request): Promise<CapturedPng> => {
      const pixels = drawFrame(gl, scene, request);
      invalidate(); // the next on-screen frame is drawn as usual (the target / mask are already undone)
      return { png: await pngOf(pixels, request.width, request.height), width: request.width, height: request.height };
    });
    return () => setViewportCapturer(null);
  }, [gl, scene, invalidate]);

  return null;
}
