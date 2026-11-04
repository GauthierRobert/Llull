// Eye-dome lighting (Boucheron & Rosenlicht, 2006) for point clouds. A depth pre-pass draws the cloud layer alone into a float target
// (view depth per pixel); the cloud material then darkens each fragment by how far its four screen neighbours sit in front of it
// (log2 depth). Only the cloud material reads the target, so solids keep their own shading. Pure helpers + the GLSL; the pass is EdlPass.tsx.

import type * as THREE from 'three';

export const EDL_DEFAULT_STRENGTH = 0.4;
export const EDL_DEFAULT_RADIUS_PX = 1.4;
/** Potree's exponent scale: shade = exp(-response * SCALE * strength). */
const EDL_SCALE = 300;

export interface EdlParams {
  /** 1 / drawing-buffer size. */
  readonly texel: readonly [number, number];
  /** The four neighbour offsets in texture units (right, left, up, down), `radiusPx` away. */
  readonly offsets: readonly [number, number, number, number, number, number, number, number];
  /** Exponent multiplier. */
  readonly factor: number;
}

/** Shader parameters for a drawing buffer of `width` x `height` px. Strength is clamped to 0..4, the radius to 0.5..4 px. */
export function edlParams(width: number, height: number, strength: number, radiusPx: number): EdlParams {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const r = Math.min(4, Math.max(0.5, radiusPx));
  const dx = r / w;
  const dy = r / h;
  return { texel: [1 / w, 1 / h], offsets: [dx, 0, -dx, 0, 0, dy, 0, -dy], factor: EDL_SCALE * Math.min(4, Math.max(0, strength)) };
}

/** Shade of a fragment at view depth `depth` with the neighbours' depths (0 = no cloud there, ignored). CPU twin of the GLSL, for tests. */
export function edlShade(depth: number, neighbours: readonly number[], factor: number): number {
  let response = 0;
  for (const n of neighbours) if (n > 0 && depth > 0) response += Math.max(0, Math.log2(depth) - Math.log2(n));
  return Math.exp((-response / 4) * factor);
}

export interface EdlUniforms {
  edlDepth: THREE.IUniform<THREE.Texture | null>;
  edlOffsets: THREE.IUniform<number[]>;
  edlTexel: THREE.IUniform<[number, number]>;
  edlFactor: THREE.IUniform<number>;
  /** 1 when the pre-pass target is valid this frame, 0 otherwise (shading disabled). */
  edlOn: THREE.IUniform<number>;
  /** Point size (px) the pre-pass draws with, kept equal to the cloud material's. */
  edlPointSize: THREE.IUniform<number>;
}

export function createEdlUniforms(): EdlUniforms {
  return {
    edlDepth: { value: null },
    edlOffsets: { value: [0, 0, 0, 0, 0, 0, 0, 0] },
    edlTexel: { value: [1, 1] },
    edlFactor: { value: 0 },
    edlOn: { value: 0 },
    edlPointSize: { value: 1 },
  };
}

const FRAGMENT_HEAD = `
uniform sampler2D edlDepth;
uniform float edlOffsets[8];
uniform vec2 edlTexel;
uniform float edlFactor;
uniform float edlOn;
float edlDepthAt(vec2 uv) { return texture2D(edlDepth, uv).r; }
float edlShade() {
  vec2 uv = gl_FragCoord.xy * edlTexel;
  float z = edlDepthAt(uv);
  if (edlOn < 0.5 || z <= 0.0) return 1.0;
  float response = 0.0;
  for (int i = 0; i < 4; i++) {
    float n = edlDepthAt(uv + vec2(edlOffsets[2 * i], edlOffsets[2 * i + 1]));
    if (n > 0.0) response += max(0.0, log2(z) - log2(n));
  }
  return exp(-response * 0.25 * edlFactor);
}
`;

/** Makes `material` multiply its colour by the EDL shade read from `uniforms`. */
export function applyEdl(material: THREE.PointsMaterial, uniforms: EdlUniforms): void {
  material.onBeforeCompile = (shader): void => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader =
      FRAGMENT_HEAD +
      shader.fragmentShader.replace('#include <opaque_fragment>', 'outgoingLight *= edlShade();\n#include <opaque_fragment>');
  };
  material.customProgramCacheKey = (): string => 'llull-edl';
  material.needsUpdate = true;
}

/** Vertex + fragment of the depth pre-pass (used as the scene override material while only the cloud layer is visible). */
export const EDL_DEPTH_VERTEX = `
#include <clipping_planes_pars_vertex>
uniform float edlPointSize;
varying float vViewDepth;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = edlPointSize;
  #include <clipping_planes_vertex>
}`;
export const EDL_DEPTH_FRAGMENT = `
varying float vViewDepth;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(vViewDepth, 0.0, 0.0, 1.0);
}`;
