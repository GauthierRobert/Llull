/** Airfoil coordinate files: UIUC Selig and Lednicer text, chord normalisation, upper / lower surface split and self-intersection check. */

import type { Vec2 } from '@core/model/types';

export type AirfoilFormat = 'selig' | 'lednicer';

export interface ParsedAirfoil {
  readonly name: string;
  readonly format: AirfoilFormat;
  /** Selig order: upper trailing edge -> leading edge -> lower trailing edge. */
  readonly points: ReadonlyArray<Vec2>;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?$/;
const toNumber = (token: string): number => Number(token.replace(/[dD]/, 'e'));

/** Numbers of one line (whitespace / comma separated), or null when any token is not numeric. */
function numbersOf(line: string): number[] | null {
  const tokens = line.split(/[\s,;]+/).filter((token) => token !== '');
  return tokens.every((token) => NUMBER.test(token)) ? tokens.map(toNumber) : null;
}

/**
 * Parse an airfoil file. `format` 'auto' detects Lednicer when the first data line holds two counts > 1 (e.g. "17. 17.").
 * @failure non-numeric data line, fewer than 5 points, inconsistent Lednicer counts -> string reason naming the line
 */
export function parseAirfoilText(text: string, format: 'auto' | AirfoilFormat): ParsedAirfoil | string {
  const lines = text
    .split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter((line) => line.text !== '');
  if (lines.length === 0) return 'the text is empty';
  const first = lines[0] as { text: string; number: number };
  const firstNumbers = numbersOf(first.text);
  const named = firstNumbers === null || firstNumbers.length !== 2;
  const name = named ? first.text : 'unnamed';
  const body = named ? lines.slice(1) : lines;
  const rows: Array<{ values: number[]; line: number }> = [];
  for (const line of body) {
    const values = numbersOf(line.text);
    if (values === null || values.length !== 2) return `line ${line.number}: expected two numbers "x y" (got "${line.text.slice(0, 40)}")`;
    rows.push({ values, line: line.number });
  }
  const counts = rows[0]?.values;
  const lednicerLike = counts !== undefined && counts[0] !== undefined && counts[1] !== undefined && counts[0] > 1 && counts[1] > 1;
  const detected: AirfoilFormat = format === 'auto' ? (lednicerLike ? 'lednicer' : 'selig') : format;
  if (detected === 'selig') {
    const points = rows.map((row): Vec2 => [row.values[0] as number, row.values[1] as number]);
    return points.length < 5 ? `at least 5 points are needed (got ${points.length})` : { name, format: 'selig', points };
  }
  if (!lednicerLike || counts === undefined) return 'Lednicer files start with the point counts "upper lower" (two numbers > 1)';
  const upperCount = Math.round(counts[0] as number);
  const lowerCount = Math.round(counts[1] as number);
  const data = rows.slice(1).map((row): Vec2 => [row.values[0] as number, row.values[1] as number]);
  if (data.length !== upperCount + lowerCount)
    return `Lednicer counts ${upperCount} + ${lowerCount} do not match the ${data.length} coordinate lines`;
  const upper = data.slice(0, upperCount);
  const lower = data.slice(upperCount);
  const sharedLeadingEdge = lower[0] !== undefined && upper[0] !== undefined && lower[0][0] === upper[0][0] && lower[0][1] === upper[0][1];
  const points = [...[...upper].reverse(), ...(sharedLeadingEdge ? lower.slice(1) : lower)];
  return points.length < 5 ? `at least 5 points are needed (got ${points.length})` : { name, format: 'lednicer', points };
}

/** Index of the leading edge: the point farthest from the trailing-edge midpoint. */
export function leadingEdgeIndex(points: ReadonlyArray<Vec2>): number {
  const first = points[0] as Vec2;
  const last = points[points.length - 1] as Vec2;
  const te: Vec2 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
  let best = 0;
  let farthest = -1;
  points.forEach((point, index) => {
    const distance = Math.hypot(point[0] - te[0], point[1] - te[1]);
    if (distance > farthest) {
      farthest = distance;
      best = index;
    }
  });
  return best;
}

/** Points moved so the leading edge is at the origin, the trailing-edge midpoint on +x at distance 1 (rotation + uniform scale). */
export function normalizeToChord(points: ReadonlyArray<Vec2>): Vec2[] {
  const first = points[0] as Vec2;
  const last = points[points.length - 1] as Vec2;
  const te: Vec2 = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
  const le = points[leadingEdgeIndex(points)] as Vec2;
  const chord = Math.hypot(te[0] - le[0], te[1] - le[1]);
  const angle = Math.atan2(te[1] - le[1], te[0] - le[0]);
  const [cos, sin] = [Math.cos(-angle), Math.sin(-angle)];
  return points.map(([x, y]): Vec2 => {
    const [dx, dy] = [x - le[0], y - le[1]];
    return [(dx * cos - dy * sin) / chord, (dx * sin + dy * cos) / chord];
  });
}

/** y of the polyline `side` (monotone in x, either direction) at `x`, or null outside its x range. */
function sideHeight(side: ReadonlyArray<Vec2>, x: number): number | null {
  for (let i = 0; i + 1 < side.length; i++) {
    const [a, b] = [side[i] as Vec2, side[i + 1] as Vec2];
    if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return null;
}

/**
 * Index of the first point of the lower surface whose chordwise station lies in the interior of the chord and below the upper surface by
 * a negative thickness (> 1e-4 chord), or -1 when the surfaces never cross. Points must be chord-normalised.
 */
export function crossingIndex(points: ReadonlyArray<Vec2>): number {
  const le = leadingEdgeIndex(points);
  const upper = points.slice(0, le + 1);
  for (let i = le + 1; i < points.length; i++) {
    const [x, y] = points[i] as Vec2;
    if (x < 0.001 || x > 0.999) continue;
    const top = sideHeight(upper, x);
    if (top !== null && top < y - 1e-4) return i;
  }
  return -1;
}

/** Trailing-edge gap (distance between the first and last point) of chord-normalised points. */
export const trailingEdgeGap = (points: ReadonlyArray<Vec2>): number => {
  const first = points[0] as Vec2;
  const last = points[points.length - 1] as Vec2;
  return Math.hypot(first[0] - last[0], first[1] - last[1]);
};

/** `points` without consecutive duplicates closer than 1e-9 (a repeated leading-edge point is common in files). */
export function withoutDuplicates(points: ReadonlyArray<Vec2>): Vec2[] {
  return points.filter(
    (point, index) =>
      index === 0 || Math.hypot(point[0] - (points[index - 1] as Vec2)[0], point[1] - (points[index - 1] as Vec2)[1]) > 1e-9,
  );
}
