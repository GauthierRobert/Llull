/**
 * Dimension styles (v1.0 drawings): named, document-level presentation of `dimension` entities — text height, arrowheads, extension
 * lines and number format. A dimension uses the style named by its `styleId`; without one it keeps the built-in look of each renderer.
 * @invariant every `DimensionEntity.styleId` names a key of `CadDocument.dimensionStyles`; `activeDimensionStyleId` too when set
 */

export const DIMENSION_ARROW_STYLES = ['open', 'closed', 'tick', 'dot', 'none'] as const;
export type DimensionArrowStyle = (typeof DIMENSION_ARROW_STYLES)[number];

export const DECIMAL_SEPARATORS = ['.', ','] as const;
type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];

/** Presentation fields of a style; every one is optional and falls back to the renderer default. */
export interface DimensionStyleSettings {
  /** Value text cap height, drawing units (> 0). Renderer default: 0.5 viewport, 0.6 DXF / SVG exports. */
  textHeight?: number;
  /** Arrowhead length, drawing units (> 0). Default 0.3. */
  arrowSize?: number;
  /** Arrowhead shape. Default 'open' (two wings). */
  arrowStyle?: DimensionArrowStyle;
  /** Gap between the measured geometry and the start of each extension line, drawing units (>= 0). Default 0. */
  extensionGap?: number;
  /** Extension line overshoot past the dimension line, drawing units (>= 0). Default 0. */
  extensionBeyond?: number;
  /** Decimals of lengths; a dimension's own `precision` still wins. Default: the document `displayPrecision`. */
  precision?: number;
  /** Decimals of angles. Default 1. */
  angularPrecision?: number;
  /** Default '.'. */
  decimalSeparator?: DecimalSeparator;
  /** Drawn before the value (after Ø on a diameter), e.g. 'R' or '~'. */
  prefix?: string;
  /** Drawn after the value and before the tolerance, e.g. ' mm'. */
  suffix?: string;
  /** Hex `#rrggbb` stroke + text colour; default the dimension entity colour. */
  color?: string;
}

export interface DimensionStyle extends DimensionStyleSettings {
  readonly id: string;
  name: string;
}

export interface DimensionStyleFields {
  /** Absent until the first `create_dimension_style`. */
  dimensionStyles?: Record<string, DimensionStyle>;
  /** Style `add_dimension` gives a new dimension when it names none (`set_active_dimension_style`). */
  activeDimensionStyleId?: string;
}

export const MAX_DIMENSION_AFFIX_LENGTH = 32;
