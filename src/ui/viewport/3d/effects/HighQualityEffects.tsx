// In-Canvas post-processing chain for the effects the plain renderer has no pass for (ambient occlusion, feature edges): EffectComposer =
// RenderPass -> [HalfResGtaoPass] -> [EdgeOverlayPass] -> BackgroundOutputPass. Mounted only while an effect is on, so Draft / Standard keep
// the direct render. It renders at priority 1, replacing the drei Hud's main-scene render (the gizmo moves to priority 2 meanwhile, see
// Viewport3D), and follows the adaptive pixel ratio of RenderRig. The composer is created in an effect and disposed with it (StrictMode-safe);
// until it exists the frame is drawn directly.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { mergedEntityBounds } from '../fitBounds';
import { BackgroundOutputPass } from './BackgroundOutputPass';
import { DepthRangeCamera } from './depthRangeCamera';
import { EdgeOverlayPass } from './EdgeOverlayPass';
import { type DepthRange, GTAO_MAX_RADIUS_MM, gtaoParameters, gtaoRadius, viewDepthRange } from './gtaoSettings';
import { HalfResGtaoPass } from './HalfResGtaoPass';

/** MSAA samples of the composer's render target (the Canvas antialias only covers the default framebuffer). */
const MSAA_SAMPLES = 4;

export interface EffectFlags {
  readonly edges: boolean;
  readonly ambientOcclusion: boolean;
}

interface SceneBox {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** The document's world bounds (null for an empty one), recomputed on content change (entities are the identity; order alone misses in-place edits). */
function useSceneBox(): SceneBox | null {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  return useMemo(
    () => mergedEntityBounds(useStore.getState().document, order),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entities, order],
  );
}

/** Near/far of the depth-based passes for the camera: tight around the scene along the view (render space = world - renderOrigin). */
function depthRangeOf(box: SceneBox | null, camera: THREE.PerspectiveCamera): DepthRange | null {
  if (box === null) return null;
  const origin = useStore.getState().renderOrigin;
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const eye: [number, number, number] = [camera.position.x + origin[0], camera.position.y + origin[1], camera.position.z + origin[2]];
  return viewDepthRange(eye, [forward.x, forward.y, forward.z], box.min, box.max, camera.near, camera.far);
}

export function HighQualityEffects({ edges, ambientOcclusion }: EffectFlags): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const box = useSceneBox();
  const boxRef = useRef(box);
  boxRef.current = box;
  const aoRadius = useMemo(() => {
    const diagonal = box === null ? null : Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    return gtaoRadius(diagonal, fromMm(useStore.getState().document, GTAO_MAX_RADIUS_MM));
  }, [box]);
  const radius = useRef(aoRadius);
  radius.current = aoRadius;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const [composer, setComposer] = useState<EffectComposer | null>(null);
  /** Pixel ratio and CSS size the composer was last sized for. */
  const sized = useRef({ ratio: 0, width: 0, height: 0 });
  const background = useRef<unknown>(null);

  useEffect(() => {
    const ratio = gl.getPixelRatio();
    const { width: cssWidth, height: cssHeight } = sizeRef.current;
    const [width, height] = [cssWidth * ratio, cssHeight * ratio];
    const chain = new EffectComposer(gl, new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES }));
    // Transparent clear: the background is composited after tone mapping (BackgroundOutputPass).
    chain.addPass(new RenderPass(scene, camera, undefined, new THREE.Color(0, 0, 0), 0));
    if (camera instanceof THREE.PerspectiveCamera) {
      const depthCamera = new DepthRangeCamera(camera, (view) => depthRangeOf(boxRef.current, view));
      if (ambientOcclusion) chain.addPass(new HalfResGtaoPass(scene, camera, width, height, gtaoParameters(radius.current), depthCamera));
      if (edges) chain.addPass(new EdgeOverlayPass(scene, depthCamera, width, height));
    }
    chain.addPass(new BackgroundOutputPass(() => background.current));
    sized.current = { ratio, width: cssWidth, height: cssHeight };
    setComposer(chain);
    invalidate();
    return () => {
      setComposer(null);
      for (const pass of chain.passes) pass.dispose();
      chain.dispose();
    };
  }, [gl, scene, camera, edges, ambientOcclusion, invalidate]);

  useEffect(() => {
    for (const pass of composer?.passes ?? []) if (pass instanceof HalfResGtaoPass) pass.updateGtaoMaterial(gtaoParameters(aoRadius));
    invalidate();
  }, [composer, aoRadius, invalidate]);

  useFrame(() => {
    if (composer === null) {
      gl.render(scene, camera);
      return;
    }
    const ratio = gl.getPixelRatio();
    const last = sized.current;
    if (last.ratio !== ratio || last.width !== size.width || last.height !== size.height) {
      composer.setPixelRatio(ratio);
      composer.setSize(size.width, size.height);
      sized.current = { ratio, width: size.width, height: size.height };
    }
    // The chain renders with a transparent background; BackgroundOutputPass puts it back behind the tone-mapped image.
    background.current = scene.background;
    scene.background = null;
    try {
      composer.render();
    } finally {
      scene.background = background.current as THREE.Scene['background'];
    }
  }, 1);

  return null;
}
