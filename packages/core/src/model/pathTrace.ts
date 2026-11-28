/**
 * Optional native path tracer port (RV1 RV-M3): `ctx.pathTrace` renders the scene `render_realistic` builds (wire contract: RV1 §5b) with
 * the native `llull-compute pathtrace` job. Synchronous like `ctx.raster` (the host blocks on its job). Absent = NATIVE_TOOL_MISSING.
 */

export type Rgb = readonly [number, number, number];
type V3 = readonly [number, number, number];

export interface PathTraceCamera {
  readonly position: V3;
  readonly forward: V3;
  readonly up: V3;
  readonly projection: 'perspective' | 'orthographic';
  /** Vertical field of view, radians (perspective). */
  readonly fovY: number;
  /** Visible height in document units (orthographic). */
  readonly orthoHeight: number;
  /** Lens radius in document units; 0 = pinhole. */
  readonly apertureRadius: number;
  readonly focusDistance: number;
}

interface PathTraceMeshRange {
  readonly vertexOffset: number;
  readonly vertexCount: number;
  readonly indexOffset: number;
  readonly indexCount: number;
}

/** One material; every `*Texture` is an index into `PathTraceJob.textures` or null. Colours are scene-linear. */
export interface PathTraceMaterial {
  readonly baseColor: Rgb;
  readonly baseColorTexture: number | null;
  readonly metalness: number;
  readonly metalnessTexture: number | null;
  readonly roughness: number;
  readonly roughnessTexture: number | null;
  readonly normalTexture: number | null;
  readonly normalScale: number;
  /** Emitted radiance (strength multiplied in). */
  readonly emission: Rgb;
  readonly emissionTexture: number | null;
  readonly transmission: number;
  readonly transmissionTexture: number | null;
  readonly ior: number;
  readonly coat: number;
  readonly coatTexture: number | null;
  readonly coatRoughness: number;
}

export interface PathTraceTextureRef {
  readonly file: string;
  readonly format: 'png' | 'jpeg' | 'hdr';
  readonly colorSpace: 'srgb' | 'linear';
}

export type PathTraceLight =
  | {
      readonly type: 'sun';
      readonly direction: V3;
      readonly irradiance: Rgb;
      readonly angularRadius: number;
      readonly castShadows: boolean;
    }
  | { readonly type: 'point'; readonly position: V3; readonly power: Rgb; readonly radius: number; readonly castShadows: boolean }
  | {
      readonly type: 'spot';
      readonly position: V3;
      readonly direction: V3;
      readonly power: Rgb;
      readonly radius: number;
      readonly coneAngle: number;
      readonly blend: number;
      readonly castShadows: boolean;
    }
  | {
      readonly type: 'area';
      readonly position: V3;
      readonly uAxis: V3;
      readonly vAxis: V3;
      readonly normal: V3;
      readonly power: Rgb;
      readonly castShadows: boolean;
    };

export type PathTraceEnvironment =
  | { readonly type: 'sky'; readonly turbidity: number; readonly intensity: number; readonly sunDirection: V3 }
  | { readonly type: 'hdr'; readonly texture: number; readonly rotation: number; readonly intensity: number }
  | { readonly type: 'color'; readonly color: Rgb; readonly intensity: number }
  | { readonly type: 'default' };

/** `job.json` of the job folder (RV1 §5b). */
export interface PathTraceJob {
  readonly kind: 'pathtrace';
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly targetNoise: number | null;
  readonly maxBounces: number;
  readonly seed: number;
  readonly denoise: boolean;
  readonly engine: 'cpu' | 'gpu';
  readonly exr: boolean;
  readonly png: boolean;
  readonly exposure: number;
  readonly maxSeconds: number;
  readonly unitMetres: number;
  readonly camera: PathTraceCamera;
  readonly meshes: readonly PathTraceMeshRange[];
  readonly materials: readonly PathTraceMaterial[];
  readonly instanceCount: number;
  readonly textures: readonly PathTraceTextureRef[];
  readonly lights: readonly PathTraceLight[];
  readonly environment: PathTraceEnvironment;
}

/** Values per row of `instances.f64`: mesh index, material index, 3x4 row-major local-to-world affine. */
export const PATH_TRACE_INSTANCE_STRIDE = 14;

export interface PathTraceScene {
  readonly job: PathTraceJob;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly instances: Float64Array;
  /** Bytes of `job.textures[i]`, same order. */
  readonly textureBytes: readonly Uint8Array[];
}

/** `stats.json` of the job. */
export interface PathTraceStats {
  readonly samples: number;
  readonly seed: number;
  readonly device: string;
  readonly deterministic: boolean;
  readonly elapsedMs: number;
  readonly noise: number;
  readonly denoised: boolean;
  readonly triangles: number;
  readonly instances: number;
  readonly stoppedBy: 'samples' | 'noise' | 'time';
  readonly fallbackReason?: string;
}

export interface PathTraceImage {
  /** Tone-mapped sRGB PNG; empty when `job.png` was false. */
  readonly png: Uint8Array;
  /** Scene-linear OpenEXR (RGBA half); empty when `job.exr` was false. */
  readonly exr: Uint8Array;
  readonly stats: PathTraceStats;
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  /** Binary version, e.g. "llull-compute 0.1.0". */
  readonly version: string;
}

export type PathTraceOutcome =
  | { readonly ok: true; readonly image: PathTraceImage }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface PathTracePort {
  render(scene: PathTraceScene): PathTraceOutcome;
}
