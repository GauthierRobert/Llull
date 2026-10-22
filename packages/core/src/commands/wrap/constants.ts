/** Named numerical defaults of the wrap commands (03 WRP §5.9, D-WRP-4); every one is reported as a named default when used. */

/** Fit tolerance of pcurves / projected curves: this fraction of the solid's bounding-box diagonal ... */
export const DEFAULT_FIT_RATIO = 1e-6;
/** ... but at least this many document units. */
export const MIN_FIT_TOLERANCE = 1e-7;
/** Sewing tolerance of an emboss slab, as a fraction of the diagonal (floor MIN_FIT_TOLERANCE). */
export const SEWING_RATIO = 1e-6;
