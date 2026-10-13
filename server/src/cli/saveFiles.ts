/**
 * @layer server
 * `--save`: write the file(s) a command returned in `data` to disk. Generic over every export /
 * render command — no per-command code — by reading the payload conventions they share:
 * `files[]` ({ name|fileName, content|text }), base64 (`stlBase64`, `stepBase64`, `base64`) or text
 * (`text`, `step`, `stl`, `ifc`, `svg`). A `.png` target rasterizes `data.svg`.
 */

import fs from 'fs';
import path from 'path';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { rasterizeSvg } from '../renderImage';

export interface OutputFile {
  /** Suggested file name (from `data.fileName` / `files[].name`), or null. */
  readonly name: string | null;
  readonly bytes: Buffer;
}

const BASE64_KEYS = ['stlBase64', 'stepBase64', 'base64'] as const;
const TEXT_KEYS = ['text', 'step', 'stl', 'ifc', 'svg', 'content'] as const;

/** The single file a data record carries (base64 or text payload), or null. */
export function fileOfRecord(record: Record<string, unknown>): OutputFile | null {
  const bareName = nonEmptyString(record['name']);
  const name =
    nonEmptyString(record['fileName']) ??
    (bareName !== undefined && path.extname(bareName) !== '' ? bareName : null);
  for (const key of BASE64_KEYS) {
    const value = nonEmptyString(record[key]);
    if (value !== undefined) return { name, bytes: Buffer.from(value, 'base64') };
  }
  for (const key of TEXT_KEYS) {
    const value = nonEmptyString(record[key]);
    if (value !== undefined) return { name, bytes: Buffer.from(value, 'utf8') };
  }
  return null;
}

/**
 * The files carried by a command's `data`; empty when it carries none.
 * @pure
 */
export function filesOfData(data: unknown): OutputFile[] {
  if (!isRecord(data)) return [];
  const many = data['files'];
  if (Array.isArray(many)) {
    return many
      .filter(isRecord)
      .map(fileOfRecord)
      .filter((file): file is OutputFile => file !== null);
  }
  const one = fileOfRecord(data);
  return one === null ? [] : [one];
}

/** The PNG of `data.svg` (sized by `data.width`), or null when there is no svg or it fails. */
function pngOfData(data: unknown): OutputFile | null {
  if (!isRecord(data)) return null;
  const svg = nonEmptyString(data['svg']);
  if (svg === undefined) return null;
  const width = data['width'];
  const base64 = rasterizeSvg(svg, typeof width === 'number' ? width : undefined);
  return base64 === null ? null : { name: null, bytes: Buffer.from(base64, 'base64') };
}

export interface SavedFile {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Write the payload of `data` under `target`. One file: `target` is the file path (or a directory,
 * then the suggested name is used). Several files: `target` is a directory (created).
 * @failure no payload in data / several files but target is an existing file -> Error
 */
export function saveDataFiles(data: unknown, target: string): SavedFile[] {
  const wantsPng = path.extname(target).toLowerCase() === '.png';
  const png = wantsPng ? pngOfData(data) : null;
  // A .png target never falls back to writing svg text into a .png file.
  const files = wantsPng ? (png !== null ? [png] : []) : filesOfData(data);
  if (files.length === 0) {
    throw new Error(
      wantsPng
        ? 'the result has no data.svg that rasterizes (use render_view or a sheet export for --save *.png).'
        : 'the result carries no file payload to save (no data.files / text / base64 field).',
    );
  }
  const targetIsDirectory =
    files.length > 1 ||
    target.endsWith('/') ||
    (fs.existsSync(target) && fs.statSync(target).isDirectory());
  if (targetIsDirectory) fs.mkdirSync(target, { recursive: true });
  else fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  return files.map((file, index) => {
    const fallback = `file-${index + 1}`;
    const filePath = targetIsDirectory
      ? path.join(target, path.basename(file.name ?? fallback))
      : target;
    fs.writeFileSync(filePath, file.bytes);
    return { path: filePath, bytes: file.bytes.length };
  });
}

/**
 * `data` with every file payload replaced by a short marker, for printing after a save: the agent
 * keeps the metadata (counts, bounds, names) without megabytes of file text in its context.
 * @pure
 */
export function withoutPayloads(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(withoutPayloads);
  if (!isRecord(data)) return data;
  const payloadKeys: ReadonlySet<string> = new Set([...BASE64_KEYS, ...TEXT_KEYS]);
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      payloadKeys.has(key) && typeof value === 'string'
        ? [key, `<${value.length} chars, saved>`]
        : [key, key === 'files' ? withoutPayloads(value) : value],
    ),
  );
}
