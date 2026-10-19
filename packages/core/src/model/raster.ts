/**
 * Optional native raster port (plant 09 VIS §2.A, RS1 RS-5): `ctx.raster` draws the screen-space scene that the TypeScript render pipeline
 * prepares (`commands/render/rasterScene.ts`) and returns its RGBA pixels. The TypeScript per-pixel stage (`rasterScenePixels`) stays the
 * default and the hash reference; a port result is a picture (`deterministic: false` on the GPU) and never feeds a digest.
 * Buffers are flat float64 arrays so a host can hand them to `llull-compute raster` without re-encoding.
 */

/**
 * Screen-space scene of one render (supersampled pixels, y down).
 * @invariant faces.length = 8·F; fills.length = 3·N; loops.length = 2·L; points.length = 3·P; strokes.length = 9·S
 * @invariant every index (face, loop, point) is in range; z is affine in screen space (orthographic: camera depth; perspective: −1/depth)
 */
export interface RasterScene {
  /** Logical image size (pixels); the buffers are `samples` times larger per axis. */
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly projection: 'orthographic' | 'perspective';
  /** Linear-depth jump (document units) that draws an outline. */
  readonly depthJump: number;
  /** Cosine of the normal change that draws an outline. */
  readonly creaseCos: number;
  /** Per face: r, g, b (0..255, unrounded), nx, ny, nz, owner (−1 = stroke), flags (1 hatch, 2 line). */
  readonly faces: Float64Array;
  /** Per filled polygon, in draw order: face index, first loop, loop count (even-odd fill). */
  readonly fills: Float64Array;
  /** Per loop: first point, point count. */
  readonly loops: Float64Array;
  /** Per point: x, y (supersampled pixels), z. */
  readonly points: Float64Array;
  /** Per stroke segment, in draw order: face, ax, ay, az, bx, by, bz, half width (pixels), depth bias. */
  readonly strokes: Float64Array;
}

export interface RasterImage {
  /** RGBA of the logical image (width × height × 4). */
  readonly rgba: Uint8Array;
  /** e.g. "NVIDIA GeForce RTX 4080 (Vulkan, DiscreteGpu)" or "cpu". */
  readonly device: string;
  /** True only for a bit-reproducible engine (the native CPU twin). */
  readonly deterministic: boolean;
  /** Engine that drew the picture: `native-gpu` or `native-cpu`; `reason` says why a GPU request drew on the CPU. */
  readonly engine: 'native-gpu' | 'native-cpu';
  readonly reason?: string;
  /** Binary version, e.g. "llull-compute 0.1.0". */
  readonly version: string;
}

export type RasterOutcome =
  | { readonly ok: true; readonly image: RasterImage }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A host's offscreen rasteriser. Synchronous: commands are synchronous (the host blocks on its job). */
export interface RasterPort {
  /** `gpu` (wgpu; falls back to the CPU twin with a reason) or `cpu` (the native CPU twin, bit-identical to the reference). */
  render(scene: RasterScene, engine: 'gpu' | 'cpu'): RasterOutcome;
}
