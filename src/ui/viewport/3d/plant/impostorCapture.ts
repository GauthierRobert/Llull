// GPU capture of an octahedral impostor atlas: the prototype drawn from the direction of every cell with an orthographic camera into one
// render target (rgb = grey shading, a = coverage). Not exercised headlessly (needs a WebGL context): the desktop app is the check.

import * as THREE from 'three';
import type { AtlasCapture } from './ImpostorAtlasCache';
import { boxSphere } from './ImpostorAtlasCache';
import { ATLAS_CELL_PX, ATLAS_GRID, cellDirection } from './impostorMath';

/** Local-frame up of a view direction: +Z, or +Y looking straight along Z. The shader (plantImpostorMaterial.ts) uses the same rule. */
function viewUp(direction: readonly [number, number, number]): THREE.Vector3 {
  return Math.abs(direction[2]) > 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
}

const SHADING = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader:
    'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: 'varying vec3 vN; void main(){ float l = 0.3 + 0.7 * abs(normalize(vN).z); gl_FragColor = vec4(vec3(l), 1.0); }',
});

export function captureAtlas(renderer: THREE.WebGLRenderer): AtlasCapture {
  return (geometry, box) => {
    const { centre, radius } = boxSphere(box);
    const size = ATLAS_GRID * ATLAS_CELL_PX;
    const target = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.NoColorSpace });
    const camera = new THREE.OrthographicCamera(-radius, radius, radius, -radius, radius * 0.01, radius * 4);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, SHADING));
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    const previousClear = renderer.getClearColor(new THREE.Color());
    const previousAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      renderer.clear();
      for (let row = 0; row < ATLAS_GRID; row++) {
        for (let column = 0; column < ATLAS_GRID; column++) {
          const direction = cellDirection(column, row);
          camera.position.set(
            centre.x + direction[0] * radius * 2,
            centre.y + direction[1] * radius * 2,
            centre.z + direction[2] * radius * 2,
          );
          camera.up.copy(viewUp(direction));
          camera.lookAt(centre);
          camera.updateMatrixWorld();
          target.viewport.set(column * ATLAS_CELL_PX, row * ATLAS_CELL_PX, ATLAS_CELL_PX, ATLAS_CELL_PX);
          target.scissor.copy(target.viewport);
          target.scissorTest = true;
          renderer.render(scene, camera);
        }
      }
    } catch (error) {
      target.dispose();
      throw error;
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousAlpha);
      renderer.autoClear = previousAutoClear;
      scene.clear();
    }
    return { texture: target.texture, dispose: () => target.dispose() };
  };
}
