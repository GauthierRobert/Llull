// In-Canvas post-processing chain for the effects the plain renderer has no pass for (ambient occlusion, feature edges): EffectComposer =
// RenderPass -> [HalfResGtaoPass] -> [EdgeOverlayPass] -> BackgroundOutputPass. Mounted only while an effect is on, so Draft / Standard keep
// the direct render. It renders at priority 1, replacing the drei Hud's main-scene render (the gizmo moves to priority 2 meanwhile, see
// Viewport3D), and follows the adaptive pixel ratio of RenderRig.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { fromMm } from '@core/model/units';
import { useStore } from '@ui/store';
import { mergedEntityBounds } from '../fitBounds';
import { BackgroundOutputPass } from './BackgroundOutputPass';
import { EdgeOverlayPass } from './EdgeOverlayPass';
import { type DepthRange, GTAO_MAX_RADIUS_MM, gtaoParameters, gtaoRadius, tightDepthRange } from './gtaoSettings';
import { HalfResGtaoPass } from './HalfResGtaoPass';

/** MSAA samples of the composer's render target (the Canvas antialias only covers the default framebuffer). */
const MSAA_SAMPLES = 4;

export interface EffectFlags {
  readonly edges: boolean;
  readonly ambientOcclusion: boolean;
}

interface SceneSphere {
  /** World-space centre and radius of the document's bounds; null for an empty document. */
  readonly centre: readonly [number, number, number] | null;
  readonly radius: number;
}

/** The document's bounding sphere, recomputed on content change (entities are the identity; order alone misses in-place edits). */
function useSceneSphere(): SceneSphere {
  const entities = useStore((s) => s.document.entities);
  const order = useStore((s) => s.document.order);
  return useMemo(() => {
    const bounds = mergedEntityBounds(useStore.getState().document, order);
    if (bounds === null) return { centre: null, radius: 0 };
    const centre: [number, number, number] = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    return { centre, radius: Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities, order]);
}

/** The AO pass's depth range for the camera, from the sphere of the document (render space = world - renderOrigin). */
function depthRangeOf(sphere: SceneSphere, camera: THREE.PerspectiveCamera): DepthRange | null {
  if (sphere.centre === null) return null;
  const origin = useStore.getState().renderOrigin;
  const distance = Math.hypot(
    camera.position.x + origin[0] - sphere.centre[0],
    camera.position.y + origin[1] - sphere.centre[1],
    camera.position.z + origin[2] - sphere.centre[2],
  );
  return tightDepthRange(distance, sphere.radius, camera.near, camera.far);
}

export function HighQualityEffects({ edges, ambientOcclusion }: EffectFlags): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const sphere = useSceneSphere();
  const sphereRef = useRef(sphere);
  sphereRef.current = sphere;
  const aoRadius = useMemo(
    () => gtaoRadius(sphere.centre === null ? null : sphere.radius * 2, fromMm(useStore.getState().document, GTAO_MAX_RADIUS_MM)),
    [sphere],
  );
  const radius = useRef(aoRadius);
  radius.current = aoRadius;

  const composer = useMemo(() => {
    const ratio = gl.getPixelRatio();
    const [width, height] = [size.width * ratio, size.height * ratio];
    const chain = new EffectComposer(gl, new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES }));
    // Transparent clear: the background is composited after tone mapping (BackgroundOutputPass).
    chain.addPass(new RenderPass(scene, camera, undefined, new THREE.Color(0, 0, 0), 0));
    if (ambientOcclusion && camera instanceof THREE.PerspectiveCamera)
      chain.addPass(
        new HalfResGtaoPass(scene, camera, width, height, gtaoParameters(radius.current), (view) => depthRangeOf(sphereRef.current, view)),
      );
    if (edges) chain.addPass(new EdgeOverlayPass(scene, camera, width, height));
    chain.addPass(new BackgroundOutputPass(() => (scene.background instanceof THREE.Color ? scene.background : null)));
    return chain;
    // The chain is rebuilt when the pass set changes; the size follows in the frame callback, the AO reach in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, edges, ambientOcclusion]);

  useEffect(() => {
    invalidate();
    return () => {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    };
  }, [composer, invalidate]);

  useEffect(() => {
    for (const pass of composer.passes) if (pass instanceof HalfResGtaoPass) pass.updateGtaoMaterial(gtaoParameters(aoRadius));
    invalidate();
  }, [composer, aoRadius, invalidate]);

  useFrame(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
    // The chain renders with a transparent background; BackgroundOutputPass puts it back behind the tone-mapped image.
    const background = scene.background;
    scene.background = null;
    composer.render();
    scene.background = background;
  }, 1);

  return null;
}
