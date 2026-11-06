/**
 * `--save` of `render_animation` (PHY-22 MOV TR-MOV-17): a target with a file extension picks the file of that extension from `data.files`
 * (`.mp4`, `.gif`, `.apng`; `.png` = `sheet.png`) and writes `timeline.json` beside a video as `<name>.timeline.json`. A directory target
 * (trailing slash, an existing directory, no extension) is left to the generic multi-file save.
 */

import fs from 'fs';
import path from 'path';

/** A payload of `data.files` (structurally `OutputFile` of saveFiles.ts, which imports this module). */
interface NamedBytes {
  readonly name: string | null;
  readonly bytes: Buffer;
}

/** A written file (structurally `SavedFile`). */
interface Written {
  readonly path: string;
  readonly bytes: number;
}

const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.gif', '.apng']);
const TIMELINE = 'timeline.json';
const SHEET = 'sheet.png';

function isDirectoryTarget(target: string): boolean {
  return /[\\/]$/.test(target) || path.extname(target) === '' || (fs.existsSync(target) && fs.statSync(target).isDirectory());
}

/** True when `files` is the file list of a render_animation result (it always carries timeline.json). */
const isAnimationFiles = (files: readonly NamedBytes[]): boolean => files.some((file) => file.name === TIMELINE);

function write(destination: string, bytes: Buffer): Written {
  fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return { path: destination, bytes: bytes.length };
}

/**
 * The files to write for `--save target` of an animation result, or null when the generic save applies.
 * @failure an extension target the result has no file for (e.g. `.mp4` after `format: "apng"`) -> Error naming the files it has
 */
export function saveAnimationFiles(files: readonly NamedBytes[], target: string): Written[] | null {
  if (!isAnimationFiles(files) || isDirectoryTarget(target)) return null;
  const extension = path.extname(target).toLowerCase();
  const wanted = extension === '.png' ? SHEET : VIDEO_EXTENSIONS.has(extension) ? extension : null;
  if (wanted === null) return null;
  const pick = files.find((file) => (wanted === SHEET ? file.name === SHEET : file.name !== null && path.extname(file.name).toLowerCase() === wanted));
  if (pick === undefined) {
    const have = files.map((file) => file.name ?? '(unnamed)').filter((name) => name !== TIMELINE);
    const hint = wanted === SHEET ? 'render with `sheet` {every: n} to get sheet.png' : `render with format "${wanted.slice(1)}"`;
    throw new Error(`the result has no ${wanted === SHEET ? SHEET : `${wanted} file`} (${hint}); it carries ${have.slice(0, 4).join(', ')}${have.length > 4 ? ', …' : ''}.`);
  }
  const saved = [write(target, pick.bytes)];
  const timeline = files.find((file) => file.name === TIMELINE);
  if (wanted !== SHEET && timeline !== undefined) saved.push(write(target.slice(0, target.length - path.extname(target).length) + '.timeline.json', timeline.bytes));
  return saved;
}
