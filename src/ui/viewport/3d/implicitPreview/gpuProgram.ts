// Pure side of the implicit GPU preview (05 IMP 14.x, presentation only): the `implicit_gpu_program` answer as a typed program, and the vertex / fragment
// shader text around the generated `fieldAt`. The ray marcher steps f / lipschitz (always safe for a Lipschitz field); nothing here derives geometry.

import type { Vec3 } from '@core/model/types';

export interface GpuProgram {
  readonly source: string;
  readonly constants: Float32Array;
  readonly key: string;
  readonly lipschitz: number;
  /** Longest step of the march (document units): an approximate field is not a distance, so a step may not exceed a wall. Infinity = none. */
  readonly maxStep: number;
  readonly quality: 'exact' | 'bound' | 'approximate';
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly instructionCount: number;
}

export type GpuAnswer =
  | { readonly gpu: true; readonly program: GpuProgram }
  | { readonly gpu: false; readonly unsupported: readonly string[] };

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

/** The answer of `implicit_gpu_program`; null when the data is not that shape. */
export function parseGpuAnswer(data: unknown): GpuAnswer | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d['gpu'] === false)
    return {
      gpu: false,
      unsupported: Array.isArray(d['unsupported']) ? d['unsupported'].filter((n): n is string => typeof n === 'string') : [],
    };
  const glsl = d['glsl'] as Record<string, unknown> | undefined;
  if (d['gpu'] !== true || glsl === undefined || glsl === null) return null;
  const bounds = glsl['bounds'] as { min?: unknown; max?: unknown } | undefined;
  const constants = glsl['constants'];
  const quality = glsl['quality'];
  if (
    typeof glsl['source'] !== 'string' ||
    typeof glsl['key'] !== 'string' ||
    typeof glsl['lipschitz'] !== 'number' ||
    !(glsl['lipschitz'] > 0) ||
    !Array.isArray(constants) ||
    constants.length === 0 ||
    constants.length % 4 !== 0 ||
    !constants.every((v) => typeof v === 'number') ||
    (quality !== 'exact' && quality !== 'bound' && quality !== 'approximate') ||
    bounds === undefined ||
    !isVec3(bounds.min) ||
    !isVec3(bounds.max)
  )
    return null;
  return {
    gpu: true,
    program: {
      source: glsl['source'],
      constants: Float32Array.from(constants as number[]),
      key: glsl['key'],
      lipschitz: glsl['lipschitz'],
      maxStep:
        quality === 'approximate' && typeof glsl['minFeature'] === 'number' && glsl['minFeature'] > 0
          ? STEP_CAP_FACTOR * glsl['minFeature']
          : Infinity,
      quality,
      bounds: { min: bounds.min, max: bounds.max },
      instructionCount: typeof glsl['instructionCount'] === 'number' ? glsl['instructionCount'] : 0,
    },
  };
}

/** Safety factor on the step of a field that is not a true distance: the stored Lipschitz bound of an approximate field is estimated, not proven. */
/** Longest step as a multiple of the smallest feature radius (a wall is two radii thick: a step below 1.8 radii cannot jump a straight crossing of it). */
export const STEP_CAP_FACTOR = 1.8;

export const STEP_SAFETY: Readonly<Record<GpuProgram['quality'], number>> = { exact: 1, bound: 0.95, approximate: 0.8 };

/**
 * The factor of a step: safety / L for an exact or bound field (L proven), the safety alone for an approximate one (a normalised TPMS is distance-like near its
 * surface, where the steps are small; its stored L is not a bound and the step cap protects the walls).
 */
export const stepScaleOf = (program: Pick<GpuProgram, 'quality' | 'lipschitz'>): number =>
  program.quality === 'approximate' ? STEP_SAFETY.approximate : STEP_SAFETY[program.quality] / Math.max(program.lipschitz, 1);

export const MAX_MARCH_STEPS = 320;
/** Bisection steps between the last point outside and the hit, and how many pixel footprints a march that ran out of steps may still be from the surface. */
export const REFINE_STEPS = 6;
export const ACCEPT_FACTOR = 8;
/** Section planes the preview cuts with (the viewport has one today). */
export const MAX_CLIP_PLANES = 4;
/** Fragment uniform vectors the wrapper needs besides `uC` (matrices, vectors, planes, scalars). */
export const WRAPPER_UNIFORM_VECTORS = 24;

/** Marker the shader carries so a compile failure can be traced back to its program (`llull-gpu:<key>`). */
const keyMarker = (key: string): string => `// llull-gpu:${key}`;

export const VERTEX_SHADER = `varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader around the generated `fieldAt`. The ray is marched in the mesh's local space (= document coordinates; the mesh is the support box, drawn
 * back faces only so the camera may sit inside it). Distances are in document units: d = f * uStepScale is a lower bound of the distance to the surface when f is
 * L-Lipschitz (uStepScale = safety / L; exact and bound fields), so a step of d never crosses a sign change; an approximate field (a TPMS: f = F / |grad F|,
 * unbounded near the critical points of F) is also capped at uMaxStep, below the thickness of its walls; a hit is d < eps (one pixel footprint). A hit is refined by bisection
 * between the last point outside and itself; a march that ran out of steps within ACCEPT_FACTOR footprints of the surface still counts. Section planes cut the
 * solid (F = max(f, -distance to the plane)), so the cut shows the inside. A hit writes its depth, so the preview composites with the real geometry.
 */
export function fragmentShader(fieldSource: string, key = ''): string {
  return `${keyMarker(key)}
precision highp float;
varying vec3 vLocal;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uCamLocal;
uniform vec3 uDirLocal;
uniform float uOrtho;
uniform float uDiagonal;
uniform mat4 uClipFromLocal;
uniform float uStepScale;
uniform float uMaxStep;
uniform float uPixel;
uniform float uMinEps;
uniform vec3 uColor;
uniform vec4 uClip[${MAX_CLIP_PLANES}];
uniform int uClipCount;

${fieldSource}

float F(vec3 p) {
  float f = fieldAt(p.x, p.y, p.z);
  for (int k = 0; k < ${MAX_CLIP_PLANES}; k++) {
    if (k >= uClipCount) break;
    f = max(f, -(dot(uClip[k].xyz, p) + uClip[k].w));
  }
  return f;
}

void main() {
  vec3 rd = uOrtho > 0.5 ? uDirLocal : normalize(vLocal - uCamLocal);
  vec3 ro = uOrtho > 0.5 ? vLocal - rd * uDiagonal : uCamLocal;
  vec3 safe = mix(rd, vec3(1e-9), vec3(lessThan(abs(rd), vec3(1e-9))));
  vec3 inv = 1.0 / safe;
  vec3 t0 = (uBoxMin - ro) * inv;
  vec3 t1 = (uBoxMax - ro) * inv;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  float tNear = max(max(lo.x, lo.y), lo.z);
  float tFar = min(min(hi.x, hi.y), hi.z);
  if (tFar < max(tNear, 0.0)) discard;
  float t = max(tNear, 0.0);
  float tOut = t;
  bool hit = false;
  float d = 1e30;
  float eps = uMinEps;
  for (int i = 0; i < ${MAX_MARCH_STEPS}; i++) {
    eps = (uOrtho > 0.5 ? 0.0 : uPixel * t) + uMinEps;
    d = F(ro + rd * t) * uStepScale;
    if (d < eps) { hit = true; break; }
    tOut = t;
    t += min(d, uMaxStep);
    if (t > tFar) break;
  }
  if (!hit && d < ${ACCEPT_FACTOR}.0 * eps && t <= tFar) hit = true;
  if (!hit) discard;
  float lower = tOut;
  float upper = t;
  for (int i = 0; i < ${REFINE_STEPS}; i++) {
    float mid = 0.5 * (lower + upper);
    if (F(ro + rd * mid) > 0.0) lower = mid; else upper = mid;
  }
  t = upper;
  vec3 p = ro + rd * t;
  vec4 clip = uClipFromLocal * vec4(p, 1.0);
  if (clip.w <= 0.0 || clip.z < -clip.w) discard;
  float h = max((uOrtho > 0.5 ? 0.0 : uPixel * t) + uMinEps, 1e-6);
  vec3 g = vec3(
    F(p + vec3(h, 0.0, 0.0)) - F(p - vec3(h, 0.0, 0.0)),
    F(p + vec3(0.0, h, 0.0)) - F(p - vec3(0.0, h, 0.0)),
    F(p + vec3(0.0, 0.0, h)) - F(p - vec3(0.0, 0.0, h)));
  vec3 n = dot(g, g) > 1e-24 ? normalize(g) : -rd;
  float light = 0.35 + 0.65 * abs(dot(n, -rd));
  gl_FragColor = vec4(uColor * light, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}
`;
}
