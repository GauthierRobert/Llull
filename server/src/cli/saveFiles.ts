/**
 * `--save`: write a command's `data` payload(s) to disk, generic over the shared conventions: `files[]`,
 * base64 (`BASE64_KEYS`) or text (`TEXT_KEYS`) fields. A `.png` target rasterizes `data.svg`.
 */

import fs from 'fs';
import path from 'path';
import { isRecord } from '@lib/isRecord';
import { nonEmptyString } from '@lib/nonEmptyString';
import { rasterizeSvg } from '../renderImage';

export interface OutputFile {
  readonly name: string | null; // suggested: `fileName`, or a `name` with an extension
  readonly bytes: Buffer;
}

const BASE64_KEYS = ['stlBase64', 'stepBase64', 'base64'] as const;
const TEXT_KEYS = ['text', 'step', 'iges', 'stl', 'ifc', 'dxf', 'svg', 'content'] as const;

/** The single file a data record carries (base64 or text payload), or null. */
export function fileOfRecord(record: Record<string, unknown>): OutputFile | null {
  const bareName = nonEmptyString(record['name']);
  const name =
    nonEmptyString(record['fileName']) ??
    nonEmptyString(record['filename']) ??
    (bareName !== undefined && path.extname(bareName) !== '' ? bareName : null);
  for (const [keys, encoding] of [
    [BASE64_KEYS, 'base64'],
    [TEXT_KEYS, 'utf8'],
  ] as const) {
    const value = keys.map((key) => nonEmptyString(record[key])).find((v) => v !== undefined);
    if (value !== undefined) return { name, bytes: Buffer.from(value, encoding) };
  }
  return null;
}

/** The files carried by a command's `data`; empty when it carries none. */
export function filesOfData(data: unknown): OutputFile[] {
  if (!isRecord(data)) return [];
  const many = data['files'];
  return (Array.isArray(many) ? many.filter(isRecord) : [data]).map(fileOfRecord).filter((file): file is OutputFile => file !== null);
}

/** The svg markup of `data` (data.svg, or civil sheets' svg held in data.text), or undefined. */
function svgOfData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const text = nonEmptyString(data['text']);
  return nonEmptyString(data['svg']) ?? (text?.trimStart().startsWith('<svg') === true ? text : undefined);
}

/** PNG of `svg` (sized by `data.width`); null on rasterization failure. */
function pngOfSvg(svg: string, data: unknown): OutputFile | null {
  const base64 = rasterizeSvg(svg, isRecord(data) && typeof data['width'] === 'number' ? data['width'] : undefined);
  return base64 === null ? null : { name: null, bytes: Buffer.from(base64, 'base64') };
}

/**
 * `export_gltf --save x.glb` must run with binary=true (its text payload is JSON glTF otherwise); `.gltf` with binary=false.
 * Explicit `binary` params win; any other command or target is returned as is.
 */
export function withSaveDefaults(name: string, params: unknown, save: string | undefined): unknown {
  if (name !== 'export_gltf' || save === undefined || (isRecord(params) && 'binary' in params)) return params;
  const extension = path.extname(save).toLowerCase();
  if (extension !== '.glb' && extension !== '.gltf') return params;
  return { ...(isRecord(params) ? params : {}), binary: extension === '.glb' };
}

/** The safe relative path segments of a suggested name: `meshes/a.stl` keeps its folder (URDF references it), `..`, `.` and absolute prefixes are dropped. */
function relativeParts(name: string): string[] {
  const parts = name.split(/[\\/]+/).filter((part) => part !== '' && part !== '.' && part !== '..' && !/^[A-Za-z]:$/.test(part));
  return parts.length > 0 ? parts : [path.basename(name)];
}

export interface SavedFile {
  readonly path: string;
  readonly bytes: number;
  /** Set when the file differs from what was asked (e.g. the .svg saved because the .png could not be rasterized). */
  readonly note?: string;
}

/**
 * Write `data`'s payload: one file -> `target` path (or a directory: suggested name); several -> `target` dir (created).
 * @failure no payload in data / several files but target is an existing file -> Error
 */
/** The host file a command wrote itself (`data.file = { path, bytes }`, e.g. `export_3mf` toFile), or null. */
function hostedFileOf(data: unknown): { path: string; bytes: number; name: string | null } | null {
  if (!isRecord(data)) return null;
  const file = data['file'];
  if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['bytes'] !== 'number') return null;
  return { path: file['path'], bytes: file['bytes'], name: nonEmptyString(data['fileName']) ?? null };
}

/** Moves the host file to `target` (a directory keeps the suggested name); copies across volumes. */
function saveHostedFile(hosted: { path: string; bytes: number; name: string | null }, target: string): SavedFile[] {
  const directory = target.endsWith('/') || (fs.existsSync(target) && fs.statSync(target).isDirectory());
  const destination = directory ? path.join(target, hosted.name ?? path.basename(hosted.path)) : target;
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  try {
    fs.renameSync(hosted.path, destination);
  } catch {
    fs.copyFileSync(hosted.path, destination);
    fs.rmSync(hosted.path, { force: true });
  }
  return [{ path: destination, bytes: hosted.bytes }];
}

export function saveDataFiles(data: unknown, target: string): SavedFile[] {
  const hosted = hostedFileOf(data);
  if (hosted !== null) return saveHostedFile(hosted, target);
  const wantsPng = path.extname(target).toLowerCase() === '.png';
  const svg = wantsPng ? svgOfData(data) : undefined;
  const png = svg !== undefined ? pngOfSvg(svg, data) : null;
  if (svg !== undefined && png === null) {
    const svgPath = target.replace(/\.png$/i, '.svg');
    fs.mkdirSync(path.dirname(path.resolve(svgPath)), { recursive: true });
    const bytes = Buffer.from(svg, 'utf8');
    fs.writeFileSync(svgPath, bytes);
    return [
      {
        path: svgPath,
        bytes: bytes.length,
        note: `rasterizing the svg failed (resvg could not render it); saved the .svg instead of ${target}`,
      },
    ];
  }
  const files = wantsPng ? (png !== null ? [png] : []) : filesOfData(data); // never svg text into a .png
  if (files.length === 0) {
    throw new Error(
      wantsPng
        ? 'the result has no data.svg (use render_view or a sheet export for --save *.png).'
        : 'the result carries no file payload to save (no data.files / text / dxf / svg / base64 field).',
    );
  }
  const targetIsDirectory = files.length > 1 || target.endsWith('/') || (fs.existsSync(target) && fs.statSync(target).isDirectory());
  if (targetIsDirectory) fs.mkdirSync(target, { recursive: true });
  else fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  return files.map((file, index) => {
    const filePath = targetIsDirectory ? path.join(target, ...relativeParts(file.name ?? `file-${index + 1}`)) : target;
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, file.bytes);
    return { path: filePath, bytes: file.bytes.length };
  });
}

/** `data` with file payloads replaced by a short marker: the agent keeps the metadata, not megabytes of text. */
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

/** Payload strings longer than this are not printed inline (the text cap would cut them silently). */
const MAX_INLINE_PAYLOAD_CHARS = 20_000;

/**
 * `data` for text output without --save: file payloads past `MAX_INLINE_PAYLOAD_CHARS` become a
 * note giving their full size and telling the user to rerun with `--save <path>`.
 * @pure
 */
export function elideLargePayloads(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(elideLargePayloads);
  if (!isRecord(data)) return data;
  const payloadKeys: ReadonlySet<string> = new Set([...BASE64_KEYS, ...TEXT_KEYS]);
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) =>
      payloadKeys.has(key) && typeof value === 'string' && value.length > MAX_INLINE_PAYLOAD_CHARS
        ? [key, `<${value.length} chars; not shown, rerun with --save <path> to write the full file>`]
        : [key, key === 'files' ? elideLargePayloads(value) : value],
    ),
  );
}
