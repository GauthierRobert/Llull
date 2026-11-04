// EDL depth pre-pass: before each frame, draws only the cloud layer (camera layer mask) with a depth-writing override material into a float
// target, then publishes it through the shared EDL uniforms the cloud material samples. Solids are not drawn into the target, so their
// shading is untouched. Costs one extra draw of the resident cloud tiles per frame.

import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useScanViewStore } from '@ui/store/scanViewStore';
import { EDL_DEFAULT_RADIUS_PX, EDL_DEPTH_FRAGMENT, EDL_DEPTH_VERTEX, edlParams, type EdlUniforms } from './edlShading';

/** Three.js layer the cloud tiles join (in addition to layer 0) so the pre-pass can draw them alone. */
export const EDL_LAYER = 3;

export function EdlPass({ uniforms }: { uniforms: EdlUniforms }): React.ReactElement | null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const strength = useScanViewStore((s) => s.edlStrength);
  const target = useMemo(
    () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.FloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: true,
        generateMipmaps: false,
      }),
    [],
  );
  const material = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      vertexShader: EDL_DEPTH_VERTEX,
      fragmentShader: EDL_DEPTH_FRAGMENT,
      uniforms: { edlPointSize: uniforms.edlPointSize },
      clipping: true,
    });
    return m;
  }, [uniforms]);
  useEffect(
    () => () => {
      target.dispose();
      material.dispose();
      uniforms.edlOn.value = 0;
      uniforms.edlDepth.value = null;
    },
    [target, material, uniforms],
  );

  const size = useMemo(() => new THREE.Vector2(), []);
  useFrame(({ camera }) => {
    gl.getDrawingBufferSize(size);
    if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
    const params = edlParams(size.x, size.y, strength, EDL_DEFAULT_RADIUS_PX);
    uniforms.edlOffsets.value = [...params.offsets];
    uniforms.edlTexel.value = [params.texel[0], params.texel[1]];
    uniforms.edlFactor.value = params.factor;

    const previousTarget = gl.getRenderTarget();
    const previousAlpha = gl.getClearAlpha();
    const previousColour = gl.getClearColor(new THREE.Color());
    const previousMask = camera.layers.mask;
    const { background, overrideMaterial, fog } = scene;
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, false);
    camera.layers.set(EDL_LAYER);
    scene.background = null;
    scene.fog = null;
    scene.overrideMaterial = material;
    gl.render(scene, camera);
    scene.overrideMaterial = overrideMaterial;
    scene.background = background;
    scene.fog = fog;
    camera.layers.mask = previousMask;
    gl.setRenderTarget(previousTarget);
    gl.setClearColor(previousColour, previousAlpha);

    uniforms.edlDepth.value = target.texture;
    uniforms.edlOn.value = 1;
  });
  return null;
}
