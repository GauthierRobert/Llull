/** Shared fixtures of the 03 WRP pack tests: the pinned bundled font and the reference datasets of docs/design/03-wrap-emboss/validation. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FontProvider } from '@core/geometry/fontPort';

const root = path.resolve(__dirname, '../../..');

const FIRA_PATH = path.join(root, 'server', 'fonts', 'FiraSans-Regular.ttf');
export const FIRA_SHA256 = 'c29556a2719bf613ef3d5e070e40d903a8965d9c081beca1375dc1e6e0f93c23';

export const firaBytes = (): Uint8Array => new Uint8Array(readFileSync(FIRA_PATH));

/** A reference dataset of the pack (`data/<name>.json`). */
function dataset<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(root, 'docs', 'design', '03-wrap-emboss', 'validation', 'data', `${name}.json`), 'utf8')) as T;
}

export interface GlyphReference {
  readonly char: string;
  readonly advance: number;
  readonly contours: number;
  readonly holes: number;
  readonly outerContours: number;
  readonly areaFontUnits2: number;
  readonly outlineLengthFontUnits: number;
  readonly bbox: readonly number[] | null;
}

export interface TextReference {
  readonly text: string;
  readonly capHeightMm: number;
  readonly loops: number;
  readonly areaMm2: number;
  readonly outlineLengthMm: number;
  readonly advanceWidthNoKerningMm: number;
  readonly emboss: { readonly depthMm: number; readonly cylinderEmbossVolumeMm3: number; readonly cylinderDebossVolumeMm3: number };
}

export const glyphReferences = (): GlyphReference[] => dataset<{ glyphs: GlyphReference[] }>('font_firasans_glyphs').glyphs;
export const textReferences = (): TextReference[] => dataset<{ cases: TextReference[] }>('text_cases').cases;

/** `bytes` with the OS/2 fsType patched (the pack's restricted-licence fixture, VC-WRP-20). */
export function withFsType(bytes: Uint8Array, fsType: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  for (let k = 0, count = view.getUint16(4); k < count; k++) {
    const record = 12 + 16 * k;
    if (String.fromCharCode(...copy.subarray(record, record + 4)) === 'OS/2') view.setUint16(view.getUint32(record + 8) + 8, fsType);
  }
  return copy;
}

/** The bundled-font provider a host installs, backed by the repo copy of Fira Sans. */
export const firaProvider = (bytes: Uint8Array = firaBytes()): FontProvider => ({
  list: () => [
    { id: 'fira-sans-regular', family: 'Fira Sans', style: 'Regular', licence: 'SIL OFL 1.1', sha256: FIRA_SHA256, source: 'test fixture' },
  ],
  bytes: (id) => (id === 'fira-sans-regular' ? bytes : null),
});

const SINGLE_PATH = path.join(root, 'server', 'fonts', 'LlullSingleLine.json');
const SINGLE_SHA256 = 'c891a6177f8e8019d1344eceaa8504c22aa34106ecb3e3e61e79d39bd24d921e';

/** The bundled single-line engraving font (an original open-stroke font, CC0-1.0). */
export const singleLineBytes = (): Uint8Array => new Uint8Array(readFileSync(SINGLE_PATH));

/** Both bundled fonts, as the host's provider lists them. */
export const bundledProvider = (): FontProvider => ({
  list: () => [
    ...firaProvider().list(),
    {
      id: 'llull-single-line',
      family: 'LLULL Single Line',
      style: 'Regular',
      licence: 'CC0-1.0',
      sha256: SINGLE_SHA256,
      source: 'test fixture',
    },
  ],
  bytes: (id) => (id === 'llull-single-line' ? singleLineBytes() : firaProvider().bytes(id)),
});
