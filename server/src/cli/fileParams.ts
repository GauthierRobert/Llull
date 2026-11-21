/**
 * File references in CLI params, so commands stay pure (they only ever see the value):
 * `key=@img:path/to/scan.png` -> a base64 data URL (`add_image_underlay dataUrl=@img:scan.png`);
 * `key=@text:path/to/part.lld` -> the file's UTF-8 text (`apply_design source=@text:part.lld`).
 */

import { dirname, join } from 'node:path';

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

const USE_LINE = /^[ \t]*use[ \t]+"([^"\n]+)"/gm;
/** Same limit as the design language (`MAX_MODULE_FILES`): more files are left for the pure side to refuse. */
const MAX_MODULE_FILES = 64;

/** The key a module path is stored under (`./a//b.lld` -> `a/b.lld`), or null when it could leave the design folder (the design language refuses it by name). */
function moduleKey(path: string): string | null {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0')) return null;
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.includes('..') || segments.length === 0 ? null : segments.join('/');
}

/**
 * `apply_design` / `expand_design` with `source=@text:dir/part.lld`: the module files its `use "x.lld"` lines name (transitively, relative to
 * the folder of the design file) added as `modules` { path: text }, so commands stay pure. Unreadable or unsafe paths are left out: the
 * command refuses them by name (DESIGN_MODULE_NOT_FOUND / DESIGN_MODULE_PATH). An explicit `modules` param is kept as is.
 */
export function withModuleFiles(name: string, raw: unknown, resolved: unknown, readBytes: (path: string) => Buffer): unknown {
  if (name !== 'apply_design' && name !== 'expand_design') return resolved;
  if (typeof raw !== 'object' || raw === null || typeof resolved !== 'object' || resolved === null) return resolved;
  const reference = (raw as Record<string, unknown>)['source'];
  const params = resolved as Record<string, unknown>;
  if (typeof reference !== 'string' || !reference.startsWith(TEXT_REF_PREFIX) || params['modules'] !== undefined) return resolved;
  const root = dirname(reference.slice(TEXT_REF_PREFIX.length));
  const files: Record<string, string> = {};
  const queue = [String(params['source'] ?? '')];
  for (let text = queue.shift(); text !== undefined; text = queue.shift()) {
    for (const match of text.matchAll(USE_LINE)) {
      const key = moduleKey(match[1] ?? '');
      if (key === null || key in files || Object.keys(files).length >= MAX_MODULE_FILES) continue;
      try {
        files[key] = readBytes(join(root, key)).toString('utf8');
        queue.push(files[key]);
      } catch {
        continue;
      }
    }
  }
  return Object.keys(files).length === 0 ? resolved : { ...params, modules: files };
}
