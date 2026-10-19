/**
 * File references in CLI params, so commands stay pure (they only ever see the value):
 * `key=@img:path/to/scan.png` -> a base64 data URL (`add_image_underlay dataUrl=@img:scan.png`);
 * `key=@text:path/to/part.lld` -> the file's UTF-8 text (`apply_design source=@text:part.lld`).
 */

const IMAGE_REF_PREFIX = '@img:';
const TEXT_REF_PREFIX = '@text:';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** `data:image/png|jpeg;base64,…` of `bytes`, sniffed from the magic bytes (not the extension). */
export function imageDataUrl(bytes: Buffer, origin: string): string {
  const isPng = PNG_MAGIC.every((byte, index) => bytes[index] === byte);
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error(`${origin} is not a PNG or JPEG image`);
  return `data:image/${isPng ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}

/**
 * `params` with each top-level `"@img:<path>"` string replaced by that file's data URL and each `"@text:<path>"` by its UTF-8 text.
 * @failure unreadable file, or a non-PNG/JPEG `@img:` file -> Error naming it (from `readBytes` / `imageDataUrl`)
 */
export function resolveFileRefs(params: unknown, readBytes: (path: string) => Buffer): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (typeof value !== 'string') return [key, value];
      if (value.startsWith(IMAGE_REF_PREFIX)) {
        const path = value.slice(IMAGE_REF_PREFIX.length);
        return [key, imageDataUrl(readBytes(path), path)];
      }
      if (value.startsWith(TEXT_REF_PREFIX)) return [key, readBytes(value.slice(TEXT_REF_PREFIX.length)).toString('utf8')];
      return [key, value];
    }),
  );
}
