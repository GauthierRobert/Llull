/** Fonts embedded in the document (03 WRP): the record that names a `font/ttf` (TrueType) , `font/otf` (CFF) or `font/x-llull-stroke` (single-line) blob and the metrics read from it when it was imported. */

/** Embedding permission read from OS/2 `fsType`; a restricted font is never stored. */
type FontEmbedding = 'installable' | 'editable' | 'preview_print';

/**
 * @invariant `blob` is a key of `CadDocument.blobs` with media type `font/ttf` (format truetype), `font/otf` (cff) or `font/x-llull-stroke` (stroke); every metric was read from those bytes at import
 * @invariant `capHeight` and `unitsPerEm` are in font units, `capHeight` > 0 (OS/2 sCapHeight, else the height of 'H')
 */
export interface FontRecord {
  /** Step-scoped id, e.g. `font-3.1`. */
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly blob: string;
  readonly format: 'truetype' | 'cff' | 'stroke';
  readonly unitsPerEm: number;
  readonly capHeight: number;
  /** How `capHeight` was found: the OS/2 value or the measured 'H' outline. */
  readonly capHeightSource: 'os2' | 'glyph_H' | 'declared';
  readonly embedding: FontEmbedding;
  readonly licence?: string;
  /** `verified`: the bytes match a pinned sha256 (a bundled font), or the caller pinned `sourceSha256` and it matched. */
  readonly provenance: { readonly verified: boolean; readonly source?: string };
}

/** The curve a text follows. */
interface TextCurveLink {
  /** Id of a line / arc / circle / ellipse / polyline / spline entity in the text's plane. */
  readonly curveId: string;
  /** Arc length added to the anchor position along the curve, document units (default 0). */
  readonly offset?: number;
  /** Run along the curve from its end to its start (the text then stands on the other side). */
  readonly reverse?: boolean;
}

/** Outline-text fields of a `text` entity (03 WRP). */
export interface TextLayout {
  /** Id of a `doc.fonts` record: the text is then a closed profile of glyph outlines; without one it stays an annotation. */
  font?: string;
  /** Vertical placement about `position` (default baseline). */
  verticalAnchor?: 'baseline' | 'cap_middle' | 'cap_top';
  /** Document units added after each glyph (default 0). */
  letterSpacing?: number;
  /** Apply `kern` pairs of the font (default true). */
  kerning?: boolean;
  /** Line pitch as a multiple of the font's line height (default 1; lines break at newline). */
  lineSpacing?: number;
  /** Bend the text along a 2D curve of the same sketch plane: the baseline follows the curve (arc length from `offset`), glyphs stand on its left side (03 WRP M5). */
  onCurve?: TextCurveLink;
}
