/** import_font / list_fonts — embed a TrueType font in the document and list the fonts text can use (03 WRP M1). */

import { base64ToUint8Array } from '../../lib/base64';
import { sha256Hex } from '../../lib/sha256';
import { blobBytes } from '../../model/blobs';
import { defineCommand, z } from '../schema';
import { changed, report } from '../noop';
import { MAX_FONT_BYTES } from '../../lib/font/font';
import type { CommandResult } from '../types';
import { isFontFailure, registerFont } from './fontStore';
import { wrapRejection } from './codes';

/**
 * @affects creates 1 font record `doc.fonts[font-<step>.<k>]` and its `font/ttf` blob (the raw bytes, keyed by their sha256), unless the same bytes are already stored
 * @invariant the font is parsed completely (every glyph, all offsets bounded) before anything is stored; embedding permission is enforced (OS/2 fsType 2 and bitmap-only refuse)
 * @invariant fonts are `unverified` unless `sourceSha256` was given and matches the bytes; replay needs no font file: the recorded step keeps only `blob` (the sha256), the bytes live once in the document blobs
 * @failure not base64 / not a font / truncated -> WRP_FONT_PARSE; CFF, WOFF, collection -> WRP_FONT_FORMAT_UNSUPPORTED (CFF2, WOFF, collections); fsType 2 -> WRP_FONT_EMBEDDING_RESTRICTED; > 4 MB -> WRP_FONT_TOO_LARGE
 */
export const importFont = defineCommand({
  name: 'import_font',
  description:
    'Embed a TrueType (.ttf) or CFF-outline OpenType (.otf) font in the document so text can be turned into outlines (text_outline, extrude_profile, emboss_on_face). ' +
    'Give the file as `base64` (CLI: `file=PATH` or `path=PATH` reads the file and fills it). The font is parsed completely and stored with the ' +
    'document, so a reopened document needs no font file. Refused when the font forbids embedding (OS/2 fsType restricted), is larger than 4 MB, ' +
    'is CFF2 / WOFF / a collection (not supported) or is damaged. The result is `unverified` unless you pass the sha256 of ' +
    'the file as `sourceSha256` and it matches. Importing the same bytes twice returns the first record. Next: add_text with font=<id>, then ' +
    'text_outline. Refusals carry error.code WRP_FONT_PARSE, WRP_FONT_FORMAT_UNSUPPORTED, WRP_FONT_EMBEDDING_RESTRICTED, WRP_FONT_TOO_LARGE.',
  params: z.object({
    base64: z.string().optional().describe('The font file bytes, base64 encoded. The CLI fills it from file=PATH or path=PATH.'),
    path: z
      .string()
      .optional()
      .describe('Original file path, kept only as provenance text; the CLI also reads the file from it when base64 is absent.'),
    licence: z
      .string()
      .optional()
      .describe('Licence text to record, e.g. "SIL OFL 1.1". Default: the licence string of the font name table, if any.'),
    blob: z
      .string()
      .optional()
      .describe(
        'Recorded by the command itself: the sha256 of the font blob already embedded in the document. Replay reads the bytes from there; give base64 instead.',
      ),
    sourceSha256: z
      .string()
      .optional()
      .describe('sha256 (hex) you expect the font bytes to have. A match marks the font verified; a mismatch refuses the import.'),
  }),
  run: (doc, params): CommandResult => {
    const reject = (code: string, message: string, paths: string[] = []): CommandResult =>
      wrapRejection(doc, 'import_font', code, message, [], paths);
    const stored = params.blob === undefined ? undefined : doc.blobs?.[params.blob];
    if (params.base64 === undefined && stored === undefined)
      return reject('WRP_FONT_PARSE', 'no font bytes: give base64 (CLI: file=PATH)', ['base64']);
    const bytes = params.base64 !== undefined ? base64ToUint8Array(params.base64) : stored === undefined ? null : blobBytes(stored);
    if (bytes === null) return reject('WRP_FONT_PARSE', 'base64 is not valid base64', ['base64']);
    if (bytes.length > MAX_FONT_BYTES)
      return reject('WRP_FONT_TOO_LARGE', `${bytes.length} bytes exceed the ${MAX_FONT_BYTES}-byte limit`, ['base64']);
    const sha256 = sha256Hex(bytes);
    if (params.sourceSha256 !== undefined && params.sourceSha256.toLowerCase() !== sha256)
      return reject('WRP_FONT_PARSE', `the font sha256 is ${sha256}, not the pinned ${params.sourceSha256}`, ['sourceSha256']);
    const registered = registerFont(doc, bytes, {
      licence: params.licence,
      verified: params.sourceSha256 !== undefined,
      source: params.path === undefined ? 'import_font' : `file ${params.path}`,
    });
    if (isFontFailure(registered)) return reject(registered.code, registered.message, ['base64']);
    const { record, existing } = registered;
    const data = {
      id: record.id,
      family: record.family,
      style: record.style,
      format: record.format,
      sha256,
      bytes: bytes.length,
      glyphs: registered.glyphs,
      unitsPerEm: record.unitsPerEm,
      capHeight: record.capHeight,
      capHeightSource: record.capHeightSource,
      embedding: record.embedding,
      ...(record.licence !== undefined ? { licence: record.licence } : {}),
      verified: record.provenance.verified,
      unverified: !record.provenance.verified,
      existing,
    };
    const summary = existing
      ? `import_font: the document already holds these bytes as ${record.id} (${record.family} ${record.style}); nothing added.`
      : `import_font: embedded ${record.family} ${record.style} as ${record.id} (${registered.glyphs} glyphs, ${bytes.length} bytes, cap height ${record.capHeight} of ${record.unitsPerEm} units, embedding ${record.embedding}, ${record.provenance.verified ? 'verified against the pinned sha256' : 'unverified: no pinned sha256'}).`;
    const recorded = existing ? {} : { recordExtras: { base64: undefined, blob: record.blob } };
    return { ...changed(registered.document, summary, [record.id]), data, ...recorded };
  },
});

/**
 * @affects none (read-only)
 * @invariant lists the host's bundled fonts (ctx.fonts) and the fonts embedded in the document, each with family, style, format, licence and whether its bytes are verified
 */
export const listFonts = defineCommand({
  name: 'list_fonts',
  description:
    'List the fonts text can use: the fonts bundled with llull (usable by family name in add_text font=..., embedded in the document on first use) ' +
    'and the fonts already embedded in this document by import_font. Each entry gives id, family, style, format, licence, sha256, source ' +
    '("bundled" or "document") and `verified` (the bytes match a pinned sha256). Next: add_text with font=<id or family>.',
  params: z.object({}),
  annotations: { readOnly: true },
  run: (doc, _params, ctx): CommandResult => {
    const bundled = (ctx?.fonts?.list() ?? []).map((font) => ({
      id: font.id,
      family: font.family,
      style: font.style,
      format: 'truetype',
      licence: font.licence,
      sha256: font.sha256,
      source: 'bundled',
      verified: true,
    }));
    const embedded = Object.values(doc.fonts ?? {}).map((font) => ({
      id: font.id,
      family: font.family,
      style: font.style,
      format: font.format,
      ...(font.licence !== undefined ? { licence: font.licence } : {}),
      sha256: font.blob,
      source: 'document',
      verified: font.provenance.verified,
    }));
    const fonts = [...bundled, ...embedded];
    return report(
      doc,
      `list_fonts: ${bundled.length} bundled, ${embedded.length} in the document${fonts.length === 0 ? ' (none: import_font adds one)' : ''}.`,
      { fonts },
    );
  },
});
