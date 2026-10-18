/**
 * Screen-space label placement for render_view annotations: approximate text boxes, and a deterministic pass that slides a movable label
 * along its dimension line (then across it) until it clears every fixed box and every label placed before it.
 * @invariant same input -> same shifts (no randomness, no floating accumulation across calls)
 * @failure no free spot within MAX_TRIES steps -> shift [0, 0] (the label stays at its anchor)
 */

export interface LabelBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PlacementRequest {
  readonly box: LabelBox;
  /** Unit screen direction of the dimension line the label belongs to. */
  readonly along: readonly [number, number];
  readonly fontPx: number;
}

/** Glyph advance of the monospace label font, in em. */
const CHAR_WIDTH_EM = 0.6;
const ASCENT_EM = 0.8;
const DESCENT_EM = 0.25;
const LINE_HEIGHT_EM = 1.2;
/** Free space kept between two labels, px. */
const GAP_PX = 2;
/** Steps tried per direction before giving up. */
const MAX_TRIES = 10;
/** Distance of one step along the dimension line, in em. */
const ALONG_STEP_EM = 1.5;
/** Distance of one step across the dimension line, in em. */
const ACROSS_STEP_EM = 1.3;

/** Padding around the world triad (its X/Y/Z letters sit just beyond the tips), px. */
const TRIAD_PAD_PX = 16;

/** Axis-aligned box of a text block anchored at (x, y): `firstDyEm` is the first baseline offset, `angleDeg` the SVG rotation about (x, y). */
export function textBox(
  x: number,
  y: number,
  lines: readonly string[],
  fontPx: number,
  firstDyEm: number,
  textAnchor: 'start' | 'middle' | 'end',
  angleDeg: number,
): LabelBox {
  const width = Math.max(1, ...lines.map((line) => [...line].length)) * CHAR_WIDTH_EM * fontPx;
  const left = textAnchor === 'start' ? 0 : textAnchor === 'end' ? -width : -width / 2;
  const top = (firstDyEm - ASCENT_EM) * fontPx;
  const bottom = (firstDyEm + (lines.length - 1) * LINE_HEIGHT_EM + DESCENT_EM) * fontPx;
  const [cos, sin] = [Math.cos((angleDeg * Math.PI) / 180), Math.sin((angleDeg * Math.PI) / 180)];
  const corners = [
    [left, top],
    [left + width, top],
    [left, bottom],
    [left + width, bottom],
  ].map(([cx, cy]) => [x + (cx ?? 0) * cos - (cy ?? 0) * sin, y + (cx ?? 0) * sin + (cy ?? 0) * cos] as const);
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function boxesOverlap(a: LabelBox, b: LabelBox, gap: number = 0): boolean {
  return a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap;
}

const shifted = (box: LabelBox, dx: number, dy: number): LabelBox => ({
  minX: box.minX + dx,
  minY: box.minY + dy,
  maxX: box.maxX + dx,
  maxY: box.maxY + dy,
});

/** Box of the world X/Y/Z triad (origin, axis tips and their letters) on a `width` x `height` canvas; null when the origin is off screen. */
export function triadBox(
  points: { origin: readonly [number, number]; tips: ReadonlyArray<readonly [number, number]> },
  width: number,
  height: number,
): LabelBox | null {
  const [ox, oy] = points.origin;
  if (ox < -TRIAD_PAD_PX || ox > width + TRIAD_PAD_PX || oy < -TRIAD_PAD_PX || oy > height + TRIAD_PAD_PX) return null;
  const xs = [ox, ...points.tips.map((tip) => tip[0])];
  const ys = [oy, ...points.tips.map((tip) => tip[1])];
  return {
    minX: Math.min(...xs) - TRIAD_PAD_PX,
    minY: Math.min(...ys) - TRIAD_PAD_PX,
    maxX: Math.max(...xs) + TRIAD_PAD_PX,
    maxY: Math.max(...ys) + TRIAD_PAD_PX,
  };
}

/** Screen shift [dx, dy] of each request, in order: each clears `fixed` and every earlier request at its final position. */
export function placeLabels(requests: readonly PlacementRequest[], fixed: readonly LabelBox[]): Array<[number, number]> {
  const occupied: LabelBox[] = [...fixed];
  return requests.map((request): [number, number] => {
    const free = (dx: number, dy: number): boolean => !occupied.some((other) => boxesOverlap(shifted(request.box, dx, dy), other, GAP_PX));
    const [ax, ay] = request.along;
    const alongStep = request.fontPx * ALONG_STEP_EM;
    const acrossStep = request.fontPx * ACROSS_STEP_EM;
    // nearest free spot first; at equal distance along the line beats across it
    const candidates: Array<[number, number]> = Array.from({ length: MAX_TRIES }, (_, i) => i + 1).flatMap((k) => [
      [ax * alongStep * k, ay * alongStep * k],
      [-ax * alongStep * k, -ay * alongStep * k],
      [-ay * acrossStep * k, ax * acrossStep * k],
      [ay * acrossStep * k, -ax * acrossStep * k],
    ]);
    const ranked = candidates
      .map((candidate, index) => ({ candidate, index, distance: Math.hypot(candidate[0], candidate[1]) }))
      .sort((a, b) => a.distance - b.distance || a.index - b.index);
    const shift: [number, number] = free(0, 0)
      ? [0, 0]
      : (ranked.find(({ candidate }) => free(candidate[0], candidate[1]))?.candidate ?? [0, 0]);
    occupied.push(shifted(request.box, shift[0], shift[1]));
    return shift;
  });
}
