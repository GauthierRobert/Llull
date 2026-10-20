/**
 * Glyph geometry of the GD&T symbols (03 GDT TECHNICAL_SPEC §5.4): strokes in a unit box (x right, y UP, 0..1), so a sheet never relies on a
 * font having the Unicode symbol. The shapes are llull's own drawing of each symbol; the proportions prescribed by the standards (paywalled)
 * are not reproduced. `placeGlyph` maps a glyph to paper millimetres (y down).
 */

import type { GeometricCharacteristic } from '../model/pmi';
import type { Vec2 } from '../model/vectors';

export type GlyphStroke =
  | { readonly kind: 'line'; readonly points: readonly Vec2[]; readonly closed?: boolean }
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number };

const line = (...points: Vec2[]): GlyphStroke => ({ kind: 'line', points });
const closed = (...points: Vec2[]): GlyphStroke => ({ kind: 'line', points, closed: true });
const circle = (x: number, y: number, radius: number): GlyphStroke => ({ kind: 'circle', center: [x, y], radius });

/** Points of an arc of the circle (cx, cy, r) from `from` to `to` radians. */
function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 16): Vec2[] {
  return Array.from({ length: steps + 1 }, (_, i): Vec2 => {
    const a = from + ((to - from) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

const GLYPHS: Readonly<Record<GeometricCharacteristic, readonly GlyphStroke[]>> = {
  straightness: [line([0.1, 0.5], [0.9, 0.5])],
  flatness: [closed([0.15, 0.3], [0.95, 0.3], [0.85, 0.7], [0.05, 0.7])],
  roundness: [circle(0.5, 0.5, 0.35)],
  cylindricity: [
    circle(0.5, 0.5, 0.2),
    line([0.08, 0.12], [0.34, 0.38]),
    line([0.92, 0.62], [0.66, 0.88]),
    line([0.08, 0.62], [0.34, 0.88]),
    line([0.92, 0.12], [0.66, 0.38]),
  ],
  profile_line: [{ kind: 'line', points: arc(0.5, 0.3, 0.4, 0, Math.PI) }],
  profile_surface: [{ kind: 'line', points: arc(0.5, 0.3, 0.4, 0, Math.PI), closed: true }],
  angularity: [line([0.1, 0.2], [0.9, 0.2]), line([0.1, 0.2], [0.75, 0.8])],
  perpendicularity: [line([0.1, 0.15], [0.9, 0.15]), line([0.5, 0.15], [0.5, 0.85])],
  parallelism: [line([0.25, 0.15], [0.45, 0.85]), line([0.55, 0.15], [0.75, 0.85])],
  position: [circle(0.5, 0.5, 0.3), line([0.5, 0.05], [0.5, 0.95]), line([0.05, 0.5], [0.95, 0.5])],
  concentricity: [circle(0.5, 0.5, 0.36), circle(0.5, 0.5, 0.2)],
  coaxiality: [circle(0.5, 0.5, 0.36), circle(0.5, 0.5, 0.2)],
  symmetry: [line([0.15, 0.7], [0.85, 0.7]), line([0.05, 0.5], [0.95, 0.5]), line([0.15, 0.3], [0.85, 0.3])],
  circular_runout: [line([0.15, 0.15], [0.8, 0.8]), line([0.45, 0.8], [0.8, 0.8], [0.8, 0.45])],
  total_runout: [
    line([0.1, 0.15], [0.55, 0.8]),
    line([0.35, 0.8], [0.55, 0.8], [0.55, 0.55]),
    line([0.45, 0.15], [0.9, 0.8]),
    line([0.7, 0.8], [0.9, 0.8], [0.9, 0.55]),
  ],
};

/** Glyph of a characteristic. */
export const characteristicGlyph = (characteristic: GeometricCharacteristic): readonly GlyphStroke[] => GLYPHS[characteristic];

/** Diameter symbol Ø: circle and slash. */
export const DIAMETER_GLYPH: readonly GlyphStroke[] = [circle(0.5, 0.5, 0.3), line([0.18, 0.08], [0.82, 0.92])];

/** Material condition ring (the letter is text): a circle filling the box. */
export const RING_GLYPH: readonly GlyphStroke[] = [circle(0.5, 0.5, 0.45)];

/** Datum feature triangle, pointing up (base at the bottom). */
export const TRIANGLE_GLYPH: readonly GlyphStroke[] = [closed([0.05, 0.05], [0.95, 0.05], [0.5, 0.85])];

/** Surface texture symbol: a check mark with its horizontal bar. */
export const TEXTURE_GLYPH: readonly GlyphStroke[] = [line([0.0, 0.45], [0.3, 0.0], [0.7, 0.9], [1.0, 0.9])];

/** `glyph` placed with its box's lower-left corner at paper point (x, y + size) and side `size` mm (paper y points down). */
export function placeGlyph(glyph: readonly GlyphStroke[], x: number, y: number, size: number): GlyphStroke[] {
  const map = ([u, v]: Vec2): Vec2 => [x + u * size, y + (1 - v) * size];
  return glyph.map((stroke) =>
    stroke.kind === 'circle'
      ? { kind: 'circle', center: map(stroke.center), radius: stroke.radius * size }
      : { ...stroke, points: stroke.points.map(map) },
  );
}
