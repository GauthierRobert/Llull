/**
 * Portal hall plan/roof geometry shared by the member and cladding phases.
 * @layer domain-aec
 */

import type { SteelProfile } from '../steel/profiles';

/** Resolved steel sections of a portal hall. */
export interface PortalProfiles {
  readonly column: SteelProfile;
  readonly rafter: SteelProfile;
  readonly purlin: SteelProfile;
  readonly rail: SteelProfile;
  readonly brace: SteelProfile;
  readonly gable: SteelProfile;
}

/** One roof slope of a span: from its low end at a column line up to its high end. */
export interface Slope {
  readonly side: -1 | 1;
  readonly lowX: number;
  readonly lowZ: number;
  readonly highX: number;
  readonly highZ: number;
}

interface HallGeometryInput {
  readonly originX: number;
  readonly originY: number;
  readonly spanWidths: ReadonlyArray<number>;
  readonly bays: number;
  readonly bay: number;
  readonly pitch: number;
  readonly eave: number;
  readonly monopitch: boolean;
  readonly mm: (value: number) => number;
}

export interface HallGeometry {
  readonly mm: (value: number) => number;
  readonly h: (profile: SteelProfile) => number;
  readonly bays: number;
  readonly pitch: number;
  readonly eave: number;
  readonly monopitch: boolean;
  readonly columnLines: ReadonlyArray<number>;
  readonly spanBounds: ReadonlyArray<readonly [number, number]>;
  readonly x0: number;
  readonly x1: number;
  readonly totalWidth: number;
  readonly ys: ReadonlyArray<number>;
  readonly y0: number;
  readonly yEnd: number;
  readonly ridge: number;
  readonly roofLine: (x: number) => number;
  readonly columnTop: (x: number) => number;
  readonly slopesOf: (bounds: readonly [number, number]) => Slope[];
}

/** Column lines, frame lines and roof-line functions of a hall. */
export function buildHallGeometry(input: HallGeometryInput): HallGeometry {
  const { originX, originY, spanWidths, bays, bay, pitch, eave, monopitch, mm } = input;
  const columnLines = spanWidths.reduce<number[]>(
    (lines, width) => [...lines, (lines[lines.length - 1] as number) + width],
    [originX],
  );
  const spanBounds = spanWidths.map((_, index): readonly [number, number] => [
    columnLines[index] as number,
    columnLines[index + 1] as number,
  ]);
  const x0 = columnLines[0] as number;
  const x1 = columnLines[columnLines.length - 1] as number;
  const totalWidth = x1 - x0;
  const ys = Array.from({ length: bays + 1 }, (_, index) => originY + index * bay);
  const rise = Math.tan(pitch);
  /** Roof-line height above x: monopitch rises from the low eaves at x0, duopitch peaks mid-span. */
  const roofLine = (x: number): number => {
    if (monopitch) return eave + (x - x0) * rise;
    const [a, b] =
      spanBounds.find(([from, to]) => x >= from && x <= to) ??
      (x < x0
        ? (spanBounds[0] as readonly [number, number])
        : (spanBounds[spanBounds.length - 1] as readonly [number, number]));
    return eave + Math.min(x - a, b - x) * rise;
  };
  /** Column height at a column line (the eaves). */
  const columnTop = (x: number): number => (monopitch ? roofLine(x) : eave);
  /** Roof slopes of a span, each from its low end (at a column line) up to its high end. */
  const slopesOf = (bounds: readonly [number, number]): Slope[] => {
    const [a, b] = bounds;
    if (monopitch) {
      return [{ side: -1, lowX: a, lowZ: roofLine(a), highX: b, highZ: roofLine(b) }];
    }
    const middle = (a + b) / 2;
    const peak = eave + ((b - a) / 2) * rise;
    return [
      { side: -1, lowX: a, lowZ: eave, highX: middle, highZ: peak },
      { side: 1, lowX: b, lowZ: eave, highX: middle, highZ: peak },
    ];
  };
  const ridge = Math.max(
    ...spanBounds.flatMap((bounds) => slopesOf(bounds).map((slope) => slope.highZ)),
  );
  return {
    mm,
    h: (profile) => mm(profile.h),
    bays,
    pitch,
    eave,
    monopitch,
    columnLines,
    spanBounds,
    x0,
    x1,
    totalWidth,
    ys,
    y0: ys[0] as number,
    yEnd: ys[ys.length - 1] as number,
    ridge,
    roofLine,
    columnTop,
    slopesOf,
  };
}
