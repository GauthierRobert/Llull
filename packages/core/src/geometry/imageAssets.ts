/**
 * Image asset port (RV1 RV-M1): texture files live in the host's content-addressed image asset store, outside the document; the document
 * holds a `TextureRecord` (key = sha256 of the file bytes). A pure command never writes a file: `writeImage` is an idempotent cache write
 * (same bytes, same key), so a replay recomputes the same key and the document stays a pure function of its inputs (as the mesh asset port).
 * The desktop renderer reads the bytes back over the backend's `GET /assets/image/<key>`.
 */

export interface ImageAssetPort {
  /** Bytes of the stored image `key` (64 lowercase hex), or null when this machine does not hold it. */
  readImage(key: string): Uint8Array | null;
  /** Store `bytes` (sha256 -> key); writing the same bytes twice is a no-op. Returns the key. */
  writeImage(bytes: Uint8Array): string;
}

let installed: ImageAssetPort | null = null;

/** Install (or clear with null) the host's image asset store; `defaultContext` hands it to commands as `ctx.imageAssets`. */
export function setImageAssetPort(port: ImageAssetPort | null): void {
  installed = port;
}

export function getImageAssetPort(): ImageAssetPort | null {
  return installed;
}
