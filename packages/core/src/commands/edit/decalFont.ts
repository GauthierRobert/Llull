/**
 * The font side of `add_decal` (03 WRP M4): the outline of the text in a document font rasterised once into the decal's 1-bit mask, so the viewport and the glTF export need no
 * font engine and a reopened document needs no font file (the mask is stored with the decal).
 * @failure unknown font, a font that cannot outline the text, a text with no ink -> `{ code, message }`
 */

import type { CadDocument } from '../../model/types';
import type { DecalMask } from '../../model/decal';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { flattenLoop } from '../../lib/font/outline';
import { packMask, rasterizePolygons } from '../../lib/outlineRaster';
import { outlineErrorCode, textOutline } from '../../geometry/textOutline';
import type { ExecutionContext } from '../types';
import type { AxisValues } from '../../lib/font/variation';
import { isFontFailure, loadFont, resolveFont } from '../wrap/fontStore';

/** Pixel rows of a text mask: coarse enough to keep the stored bits small (a line of ten letters is under 3 KB), fine enough for paint. */
const ROWS = 64;
const MAX_COLUMNS = 1024;
const FLATTEN = 16;

export interface FontDecal {
  readonly document: CadDocument;
  readonly mask: DecalMask;
  /** Width and height of the ink box at the requested cap height, document units. */
  readonly inkWidth: number;
  readonly inkHeight: number;
  /** Characters the font has no glyph for. */
  readonly missing: readonly string[];
  readonly family: string;
  readonly unverified: boolean;
}

export function fontDecal(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  reference: string,
  text: string,
  capHeight: number,
  variation?: AxisValues,
): FontDecal | { readonly code: string; readonly message: string } {
  const resolved = resolveFont(doc, ctx, reference, variation);
  if (isFontFailure(resolved)) return resolved;
  const loaded = loadFont(resolved.document, resolved.record.id);
  if (isFontFailure(loaded)) return loaded;
  const outline = textOutline({ content: text, height: capHeight, anchor: 'left' }, loaded.font);
  if ('error' in outline) return { code: outlineErrorCode(outline.error), message: outline.message };
  const box = outline.bbox;
  if (box === null || !(box.max[0] - box.min[0] > 0) || !(box.max[1] - box.min[1] > 0))
    return { code: 'WRP_PROFILE_EMPTY', message: `the text "${text}" has no ink in font '${loaded.record.family}'` };
  const inkWidth = box.max[0] - box.min[0];
  const inkHeight = box.max[1] - box.min[1];
  const columns = Math.min(MAX_COLUMNS, Math.max(8, Math.round((ROWS * inkWidth) / inkHeight)));
  const rows = columns === MAX_COLUMNS ? Math.max(1, Math.round((MAX_COLUMNS * inkHeight) / inkWidth)) : ROWS;
  const polygons = outline.regions.flatMap((region) => [region.outer, ...region.holes]).map((loop) => flattenLoop(loop, FLATTEN));
  const coverage = rasterizePolygons(polygons, { minX: box.min[0], maxX: box.max[0], minY: box.min[1], maxY: box.max[1] }, columns, rows);
  return {
    document: resolved.document,
    mask: { width: columns, height: rows, bits: uint8ArrayToBase64(packMask(coverage)) },
    inkWidth,
    inkHeight,
    missing: outline.layout.missing,
    family: loaded.record.family,
    unverified: !loaded.record.provenance.verified,
  };
}
