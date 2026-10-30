/**
 * Fonts in the document (03 WRP): store a font as a `font/ttf` or `font/otf` blob + `FontRecord`, find it again, and turn a font reference (record id, family name
 * or bundled id) into a record, embedding a bundled font on first use so a reopened document needs no font file (VC-WRP-19).
 * @invariant a stored font was parsed completely (every glyph) before it was stored; the blob key is the sha256 of the raw font bytes; one blob can back several records, one per
 *   variable-font instance (`FontRecord.variation`, absolute design values from the font defaults)
 */

import { blobBytes, makeBinaryBlob, withBlob } from '../../model/blobs';
import type { CadDocument } from '../../model/types';
import type { FontRecord } from '../../model/fonts';
import { parseFont, validateGlyphs, type ParsedFont } from '../../lib/font/font';
import type { AxisValues, VariationAxis } from '../../lib/font/variation';
import type { FontErrorCode } from '../../lib/font/reader';
import { sha256Hex } from '../../lib/sha256';
import { nextId } from '../../lib/id';
import type { ExecutionContext } from '../types';

export interface FontFailure {
  readonly code: FontErrorCode | 'WRP_FONT_UNAVAILABLE';
  readonly message: string;
}

export const isFontFailure = (value: unknown): value is FontFailure => typeof value === 'object' && value !== null && 'code' in value;

const MAX_CACHED_FONTS = 16;
const parsedByBlob = new Map<string, ParsedFont>();

const cacheKey = (sha256: string, instance: AxisValues | undefined): string => `${sha256}|${JSON.stringify(instance ?? {})}`;

function remember(sha256: string, font: ParsedFont): void {
  const key = cacheKey(sha256, font.instance);
  if (parsedByBlob.size >= MAX_CACHED_FONTS) parsedByBlob.delete(parsedByBlob.keys().next().value as string);
  parsedByBlob.set(key, font);
}

export interface LoadedFont {
  readonly record: FontRecord;
  readonly font: ParsedFont;
}

/** The record `id` of the document and its parsed font (cached by blob hash). @failure unknown id, missing or unreadable blob -> FontFailure */
export function loadFont(doc: CadDocument, id: string): LoadedFont | FontFailure {
  const record = doc.fonts?.[id];
  if (record === undefined) return { code: 'WRP_FONT_UNAVAILABLE', message: `font '${id}' is not in the document` };
  const blob = doc.blobs?.[record.blob];
  if (blob === undefined) return { code: 'WRP_FONT_UNAVAILABLE', message: `font '${id}' lost its bytes (blob ${record.blob})` };
  const cached = parsedByBlob.get(cacheKey(record.blob, record.variation));
  if (cached !== undefined) return { record, font: cached };
  const bytes = blobBytes(blob);
  if (bytes === null) return { code: 'WRP_FONT_UNAVAILABLE', message: `font '${id}' lost its bytes (blob ${record.blob})` };
  const parsed = parseFont(bytes, record.variation);
  if (!parsed.ok) return { code: parsed.code, message: parsed.message };
  remember(record.blob, parsed.font);
  return { record, font: parsed.font };
}

const MEDIA_TYPE = { truetype: 'font/ttf', cff: 'font/otf', stroke: 'font/x-llull-stroke' } as const;

export interface RegisterOptions {
  readonly licence?: string | undefined;
  readonly verified: boolean;
  readonly source?: string | undefined;
  /** Axis values (design units) of the instance to record; omitted or all-default = the default instance. */
  readonly variation?: AxisValues | undefined;
}

export interface Registered {
  readonly document: CadDocument;
  readonly record: FontRecord;
  /** True when the same bytes were already in the document (nothing was added). */
  readonly existing: boolean;
  readonly glyphs: number;
  readonly axes: readonly VariationAxis[];
}

/**
 * Parse `bytes` completely and add them to the document as a font.
 * @failure not a font, unsupported format, restricted embedding, too large, hostile glyph -> FontFailure
 */
export function registerFont(doc: CadDocument, bytes: Uint8Array, options: RegisterOptions): Registered | FontFailure {
  const parsed = parseFont(bytes, options.variation);
  if (!parsed.ok) return { code: parsed.code, message: parsed.message };
  const scan = validateGlyphs(parsed.font);
  if (!scan.ok) return { code: scan.code, message: scan.message };
  const blob = makeBinaryBlob(MEDIA_TYPE[parsed.font.format], bytes);
  remember(blob.sha256, parsed.font);
  const instance = parsed.font.instance;
  const known = Object.values(doc.fonts ?? {}).find(
    (record) => record.blob === blob.sha256 && JSON.stringify(record.variation ?? {}) === JSON.stringify(instance),
  );
  if (known !== undefined) return { document: doc, record: known, existing: true, glyphs: parsed.font.numGlyphs, axes: parsed.font.axes };
  const { font } = parsed;
  const licence = options.licence ?? font.names.licence;
  const record: FontRecord = {
    id: nextId('font'),
    family: font.names.family,
    style: font.names.style,
    blob: blob.sha256,
    format: font.format,
    unitsPerEm: font.unitsPerEm,
    capHeight: font.capHeight,
    capHeightSource: font.capHeightSource,
    embedding: font.embedding,
    ...(Object.keys(instance).length > 0 ? { variation: instance } : {}),
    ...(licence !== undefined ? { licence } : {}),
    provenance: { verified: options.verified, ...(options.source !== undefined ? { source: options.source } : {}) },
  };
  const document = withBlob({ ...doc, fonts: { ...doc.fonts, [record.id]: record } }, blob);
  return { document, record, existing: false, glyphs: font.numGlyphs, axes: font.axes };
}

/**
 * The fonts and font blobs of `base`, for the seed of a replay: a step that resolved a bundled font in an earlier run finds its record again, so replay
 * needs neither the font provider nor the original files.
 */
export function fontSeed(base: CadDocument): Pick<CadDocument, 'fonts' | 'blobs'> | Record<string, never> {
  const fonts = base.fonts;
  if (fonts === undefined || Object.keys(fonts).length === 0) return {};
  const kept = new Set(Object.values(fonts).map((record) => record.blob));
  const blobs = Object.fromEntries(Object.entries(base.blobs ?? {}).filter(([sha]) => kept.has(sha)));
  return { fonts, blobs };
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A font reference as a document record: a record id, a family name already in the document ("Fira Sans" or "Fira Sans Regular"), else a bundled
 * font of `ctx.fonts` (id or family), which is embedded now with its pinned sha256 as proof.
 * @failure nothing matches, or the bundled bytes differ from their pinned hash -> FontFailure WRP_FONT_UNAVAILABLE
 */
export function resolveFont(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  reference: string,
  variation?: AxisValues,
): { document: CadDocument; record: FontRecord } | FontFailure {
  const base = resolveBase(doc, ctx, reference);
  if (isFontFailure(base) || variation === undefined || Object.keys(variation).length === 0) return base;
  return instanceOf(base.document, base.record, variation);
}

/** The record of the same font bytes at `variation` (absolute design values, not relative to the record's own instance): found, or added. @failure -> FontFailure WRP_FONT_VARIATION */
function instanceOf(
  doc: CadDocument,
  record: FontRecord,
  variation: AxisValues,
): { document: CadDocument; record: FontRecord } | FontFailure {
  const stored = doc.blobs?.[record.blob];
  const bytes = stored === undefined ? null : blobBytes(stored);
  if (bytes === null) return { code: 'WRP_FONT_UNAVAILABLE', message: `font '${record.id}' lost its bytes (blob ${record.blob})` };
  const registered = registerFont(doc, bytes, {
    licence: record.licence,
    verified: record.provenance.verified,
    source: record.provenance.source,
    variation,
  });
  return isFontFailure(registered) ? registered : { document: registered.document, record: registered.record };
}

function resolveBase(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  reference: string,
): { document: CadDocument; record: FontRecord } | FontFailure {
  const own = doc.fonts?.[reference];
  if (own !== undefined) return { document: doc, record: own };
  const byName = Object.values(doc.fonts ?? {}).find(
    (record) => sameName(record.family, reference) || sameName(`${record.family} ${record.style}`, reference),
  );
  if (byName !== undefined) return { document: doc, record: byName };
  const provider = ctx?.fonts ?? null;
  const bundled = provider
    ?.list()
    .find((font) => font.id === reference || sameName(font.family, reference) || sameName(`${font.family} ${font.style}`, reference));
  if (provider === null || bundled === undefined)
    return { code: 'WRP_FONT_UNAVAILABLE', message: `no font '${reference}' in the document or among the bundled fonts` };
  const bytes = provider.bytes(bundled.id);
  if (bytes === null) return { code: 'WRP_FONT_UNAVAILABLE', message: `bundled font '${bundled.id}' could not be read` };
  if (sha256Hex(bytes) !== bundled.sha256)
    return { code: 'WRP_FONT_UNAVAILABLE', message: `bundled font '${bundled.id}' does not match its pinned sha256 ${bundled.sha256}` };
  const registered = registerFont(doc, bytes, {
    licence: bundled.licence,
    verified: true,
    source: `bundled:${bundled.id} (${bundled.source})`,
  });
  return isFontFailure(registered) ? registered : { document: registered.document, record: registered.record };
}
