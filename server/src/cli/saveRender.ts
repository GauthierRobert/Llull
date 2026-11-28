/**
 * `--save` of `render_realistic` (RV1 RV-M3; `data.illustration` true): a `.png` target takes the tone-mapped picture, an `.exr` target the
 * scene-linear EXR (inline `data.files` render.exr, else the host file `data.file`, which a .png target moves beside the picture). A directory
 * (trailing slash, no extension, or existing) gets render.png and render.exr; any other target is refused.
 */

import fs from 'fs';
import path from 'path';
import { isRecord } from '@lib/isRecord';
import { isHostedExport } from '../exportFiles';
import { moveHostedFile } from '../hostedFile';

interface Written {
  readonly path: string;
  readonly bytes: number;
}

const isRender = (data: unknown): data is Record<string, unknown> => isRecord(data) && data['illustration'] === true;

function inlineFile(data: Record<string, unknown>, name: string): Buffer | null {
  const files = Array.isArray(data['files']) ? data['files'].filter(isRecord) : [];
  const file = files.find((entry) => entry['name'] === name && typeof entry['base64'] === 'string');
  return file === undefined ? null : Buffer.from(file['base64'] as string, 'base64');
}

function hostedExr(data: Record<string, unknown>, exportDir?: string): { path: string; bytes: number } | null {
  const file = data['file'];
  if (!isRecord(file) || typeof file['path'] !== 'string' || typeof file['bytes'] !== 'number') return null;
  return isHostedExport(file['path'], exportDir) ? { path: file['path'], bytes: file['bytes'] } : null;
}

function write(destination: string, bytes: Buffer): Written {
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return { path: destination, bytes: bytes.length };
}

/**
 * The files written for `--save target` of a render_realistic result, or null when the generic save applies (not a render, or a directory).
 * @failure an .exr target and a result without an EXR (exr false, or left out over the inline limit), or a target that is neither .png, .exr
 *   nor a directory -> Error
 */
export function saveRenderFiles(data: unknown, target: string, exportDir?: string): Written[] | null {
  if (!isRender(data)) return null;
  const extension = path.extname(target).toLowerCase();
  const hosted = hostedExr(data, exportDir);
  const moveExr = (destination: string): Written => {
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    moveHostedFile((hosted as { path: string }).path, destination);
    return { path: destination, bytes: (hosted as { bytes: number }).bytes };
  };
  if (extension === '.png') {
    const png = inlineFile(data, 'render.png');
    if (png === null) throw new Error('the result has no render.png');
    // a host-written EXR goes beside the picture instead of staying in the export folder
    return [write(target, png), ...(hosted === null ? [] : [moveExr(`${target.slice(0, target.length - extension.length)}.exr`)])];
  }
  if (extension === '.exr') {
    const exr = inlineFile(data, 'render.exr');
    if (exr !== null) return [write(target, exr)];
    if (hosted === null) throw new Error('the result has no EXR (render with exr true; see data.warnings for an EXR left out)');
    return [moveExr(target)];
  }
  const directory = /[\\/]$/.test(target) || extension === '' || (fs.existsSync(target) && fs.statSync(target).isDirectory());
  if (!directory) throw new Error(`render_realistic saves as .png, .exr or into a directory, not ${extension}`);
  if (hosted === null) return null;
  fs.mkdirSync(target, { recursive: true });
  const png = inlineFile(data, 'render.png');
  const saved = png === null ? [] : [write(path.join(target, 'render.png'), png)];
  return [...saved, moveExr(path.join(target, 'render.exr'))];
}
