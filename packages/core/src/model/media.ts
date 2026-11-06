/**
 * Optional native video encoder port (PHY-22 MOV-M2, TECHNICAL_SPEC §3 / TR-MOV-11): `ctx.media` turns the PNG frames of `render_animation` into
 * a GIF or an AV1 MP4. Synchronous like `RasterPort`: the host blocks on its encoder job. Frames are handed over one at a time (`add`), so a host
 * keeps one picture in memory, never the whole clip. Absent = `render_animation` refuses gif / mp4 with NATIVE_TOOL_MISSING (apng still works).
 */

type MediaFormat = 'gif' | 'mp4';
type MediaQuality = 'draft' | 'standard' | 'high';

export interface MediaSpec {
  readonly format: MediaFormat;
  /** Frame size in pixels; even for mp4 (4:2:0). */
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly quality: MediaQuality;
  /** Number of frames that will be added. */
  readonly frames: number;
}

export interface MediaEncoder {
  /** e.g. "rav1e". */
  readonly name: string;
  readonly version: string;
  /** True when the same frames give the same bytes (the digest may be pinned). */
  readonly deterministic: boolean;
}

export type MediaFailure = { readonly ok: false; readonly code: string; readonly message: string };

/** One encode in progress: `add` every frame in order, then `finish` (or `abort` to drop it). */
export interface MediaSession {
  /** One PNG frame (exactly `width` x `height`); null when accepted. */
  add(png: Uint8Array): MediaFailure | null;
  finish(): { readonly ok: true; readonly bytes: Uint8Array; readonly encoder: MediaEncoder } | MediaFailure;
  abort(): void;
}

export interface MediaPort {
  open(spec: MediaSpec): MediaSession | MediaFailure;
}
