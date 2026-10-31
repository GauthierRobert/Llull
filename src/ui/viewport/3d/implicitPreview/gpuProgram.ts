// Pure side of the implicit GPU preview (05 IMP 14.x, presentation only): the `implicit_gpu_program` answer as a typed program, and the vertex / fragment
// shader text around the generated `fieldAt`. The ray marcher steps f / lipschitz (always safe for a Lipschitz field); nothing here derives geometry.

import type { Vec3 } from '@core/model/types';

export interface GpuProgram {
  readonly source: string;
  readonly constants: Float32Array;
  readonly key: string;
  readonly lipschitz: number;
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
      quality,
      bounds: { min: bounds.min, max: bounds.max },
      instructionCount: typeof glsl['instructionCount'] === 'number' ? glsl['instructionCount'] : 0,
    },
  };
}

/** Safety factor on the step of a field that is not a true distance: the stored Lipschitz bound of an approximate field is estimated, not proven. */
export const STEP_SAFETY: Readonly<Record<GpuProgram['quality'], number>> = { exact: 1, bound: 0.95, approximate: 0.8 };

export const MAX_MARCH_STEPS = 256;

export const VERTEX_SHADER = `varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Fragment shader around the generated `fieldAt`. The ray is marched in the mesh's local space (= document coordinates; the mesh is the support box, drawn
 * back faces only so the camera may sit inside it). A hit writes the depth of the surface point, so the preview composites with the real geometry.
 */
export function fragmentShader(fieldSource: string): string {
  return `precision highp float;
varying vec3 vLocal;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform vec3 uCamLocal;
uniform mat4 uClipFromLocal;
uniform float uStepScale;
uniform float uPixel;
uniform float uMinEps;
uniform vec3 uColor;

${fieldSource}

float F(vec3 p) { return fieldAt(p.x, p.y, p.z); }

void main() {
  vec3 rd = normalize(vLocal - uCamLocal);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBoxMin - uCamLocal) * inv;
  vec3 t1 = (uBoxMax - uCamLocal) * inv;
  vec3 lo = min(t0, t1);
  vec3 hi = max(t0, t1);
  float tNear = max(max(lo.x, lo.y), lo.z);
  float tFar = min(min(hi.x, hi.y), hi.z);
  if (tFar < max(tNear, 0.0)) discard;
  float t = max(tNear, 0.0);
  bool hit = false;
  for (int i = 0; i < ${MAX_MARCH_STEPS}; i++) {
    float eps = uPixel * t + uMinEps;
    float f = F(uCamLocal + rd * t);
    if (f < eps) { hit = true; break; }
    t += max(f * uStepScale, eps * 0.5);
    if (t > tFar) break;
  }
  if (!hit) discard;
  vec3 p = uCamLocal + rd * t;
  float h = max(uPixel * t, uMinEps);
  vec3 n = normalize(vec3(
    F(p + vec3(h, 0.0, 0.0)) - F(p - vec3(h, 0.0, 0.0)),
    F(p + vec3(0.0, h, 0.0)) - F(p - vec3(0.0, h, 0.0)),
    F(p + vec3(0.0, 0.0, h)) - F(p - vec3(0.0, 0.0, h))));
  float light = 0.35 + 0.65 * abs(dot(n, -rd));
  gl_FragColor = vec4(uColor * light, 1.0);
  vec4 clip = uClipFromLocal * vec4(p, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}
`;
}
