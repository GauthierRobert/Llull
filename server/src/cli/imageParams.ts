/**
 * @layer server
 * `key=@img:path/to/scan.png` in CLI params: the file is read and passed as a base64 data URL, so
 * `add_image_underlay dataUrl=@img:scan.png` works from a shell while the command itself stays pure
 * (it only ever sees the data URL).
 */

export const IMAGE_REF_PREFIX = '@img:';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** `data:image/png|jpeg;base64,…` of `bytes`, sniffed from the magic bytes (not the extension). */
export function imageDataUrl(bytes: Buffer, origin: string): string {
  const isPng = PNG_MAGIC.every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error(`${origin} is not a PNG or JPEG image`);
  return `data:image/${isPng ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}

/**
 * `params` with each top-level `"@img:<path>"` string replaced by that file's data URL.
 * @failure unreadable or non-PNG/JPEG file -> Error naming it (from `readBytes` / `imageDataUrl`)
 */
export function resolveImageRefs(params: unknown, readBytes: (path: string) => Buffer): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value !== 'string' || !value.startsWith(IMAGE_REF_PREFIX)) return [key, value];
      const path = value.slice(IMAGE_REF_PREFIX.length);
      return [key, imageDataUrl(readBytes(path), path)];
    }),
  );
}
