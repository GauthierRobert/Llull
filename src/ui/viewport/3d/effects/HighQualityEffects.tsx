// In-Canvas post-processing chain for the effects the plain renderer has no pass for (feature edges now): EffectComposer = RenderPass ->
// [EdgeOverlayPass] -> OutputPass (tone mapping + sRGB, which the renderer skips for a render target). Mounted only while an effect is on,
// so Draft / Standard keep the direct render. It renders at priority 1, replacing the drei Hud's main-scene render (the gizmo moves to
// priority 2 meanwhile, see Viewport3D), and follows the adaptive pixel ratio of RenderRig.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { EdgeOverlayPass } from './EdgeOverlayPass';

/** MSAA samples of the composer's render target (the Canvas antialias only covers the default framebuffer). */
const MSAA_SAMPLES = 4;

export interface EffectFlags {
  readonly edges: boolean;
}

export function HighQualityEffects({ edges }: EffectFlags): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);

  const composer = useMemo(() => {
    const ratio = gl.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(size.width * ratio, size.height * ratio, {
      type: THREE.HalfFloatType,
      samples: MSAA_SAMPLES,
    });
    const chain = new EffectComposer(gl, target);
    chain.addPass(new RenderPass(scene, camera));
    if (edges) chain.addPass(new EdgeOverlayPass(scene, camera, size.width * ratio, size.height * ratio));
    chain.addPass(new OutputPass());
    return chain;
    // The chain is rebuilt when the pass set changes; size follows below without a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, edges]);

  useEffect(() => {
    invalidate();
    return () => {
      for (const pass of composer.passes) pass.dispose();
      composer.dispose();
    };
  }, [composer, invalidate]);

  useFrame(() => {
    const ratio = gl.getPixelRatio();
    composer.setPixelRatio(ratio);
    composer.setSize(size.width, size.height);
    composer.render();
  }, 1);

  return null;
}
