// Billboard shader of an impostor bucket: one quad per instance, perpendicular to the view direction in the PROTOTYPE's local frame
// (the instance matrix carries rotation and translation, no scale), textured from the octahedral atlas cell of that direction. The cell
// rule (`octEncode`, floor to the grid) and the up vector (+Z, or +Y along Z) repeat impostorMath.ts / impostorCapture.ts.
// Instance colours (entity colour, tint, selection) multiply the baked grey shading.

import * as THREE from 'three';
import type { ImpostorAtlas } from './ImpostorAtlasCache';
import { ATLAS_GRID } from './impostorMath';

const VERTEX = /* glsl */ `
uniform vec3 uCentre;
uniform float uRadius;
varying vec2 vUv;
varying vec3 vLocalDirection;
varying vec3 vTint;
void main() {
  mat4 full = modelMatrix * instanceMatrix;
  mat3 rotation = mat3(full);
  vec3 centreWorld = full[3].xyz + rotation * uCentre;
  vec3 dir = normalize(transpose(rotation) * (cameraPosition - centreWorld));
  vec3 up0 = abs(dir.z) > 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
  vec3 right = normalize(cross(up0, dir));
  vec3 up = cross(dir, right);
  vec3 offsetLocal = (right * position.x + up * position.y) * uRadius;
  vec4 world = vec4(centreWorld + rotation * offsetLocal, 1.0);
  vUv = position.xy * 0.5 + 0.5;
  vLocalDirection = dir;
  #ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
  #else
  vTint = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uGrid;
varying vec2 vUv;
varying vec3 vLocalDirection;
varying vec3 vTint;
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 e = n.xy;
  if (n.z < 0.0) e = (1.0 - abs(e.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0);
  return e * 0.5 + 0.5;
}
void main() {
  vec2 cell = clamp(floor(octEncode(normalize(vLocalDirection)) * uGrid), 0.0, uGrid - 1.0);
  vec4 texel = texture2D(uAtlas, (cell + clamp(vUv, 0.0, 1.0)) / uGrid);
  if (texel.a < 0.5) discard;
  gl_FragColor = vec4(texel.rgb * vTint, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** One impostor material per prototype, disposed together (the atlas texture belongs to ImpostorAtlasCache, not to the material). */
export class ImpostorMaterials {
  private readonly byPrototype = new Map<string, THREE.ShaderMaterial>();

  get(prototypeKey: string, atlas: ImpostorAtlas): THREE.ShaderMaterial {
    let material = this.byPrototype.get(prototypeKey);
    if (material === undefined) {
      material = new THREE.ShaderMaterial({
        uniforms: {
          uAtlas: { value: atlas.texture },
          uCentre: { value: atlas.centre },
          uRadius: { value: atlas.radius },
          uGrid: { value: ATLAS_GRID },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: THREE.DoubleSide,
      });
      this.byPrototype.set(prototypeKey, material);
    }
    return material;
  }

  get size(): number {
    return this.byPrototype.size;
  }

  dispose(): void {
    for (const material of this.byPrototype.values()) material.dispose();
    this.byPrototype.clear();
  }
}
