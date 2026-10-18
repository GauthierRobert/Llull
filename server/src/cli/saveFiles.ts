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
const TEXT_KEYS = ['text', 'step', 'stl', 'ifc', 'dxf', 'svg', 'content'] as const;

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
export function saveDataFiles(data: unknown, target: string): SavedFile[] {
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
    const filePath = targetIsDirectory ? path.join(target, path.basename(file.name ?? `file-${index + 1}`)) : target;
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
