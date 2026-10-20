/**
 * NACA 4-digit and 5-digit 230-series airfoil ordinates, NACA Report 824 (Abbott, von Doenhoff, Stivers 1945) §II:
 * thickness yt = 5t(0.2969√x - 0.1260x - 0.3516x² + 0.2843x³ - a4 x⁴), a4 = 0.1015 (open TE) or 0.1036 (closed TE); surfaces offset
 * perpendicular to the mean line. Chord 1, leading edge at the origin.
 */

export interface NacaSection {
  readonly designation: string;
  readonly maxThickness: number;
  /** Mean-line ordinate and slope at x in [0, 1]. */
  readonly camber: (x: number) => { readonly y: number; readonly slope: number };
}

/** 5-digit mean line 230 (design cl 0.3, max camber at 15 % chord): [m, k1] (Abbott & von Doenhoff §6.5; verified against UIUC naca23012 in 02 SRF). */
const FIVE_DIGIT_MEAN_LINES: Readonly<Record<string, readonly [number, number]>> = { '230': [0.2025, 15.957] };

const flat = (): { y: number; slope: number } => ({ y: 0, slope: 0 });

/**
 * Parse "0012", "2412", "23012" (optionally prefixed "NACA").
 * @failure unsupported designation -> string reason
 */
export function parseNaca(raw: string): NacaSection | string {
  const digits = raw.replace(/^\s*naca\s*/i, '').trim();
  if (/^\d{4}$/.test(digits)) {
    const m = Number(digits[0]) / 100;
    const p = Number(digits[1]) / 10;
    const t = Number(digits.slice(2)) / 100;
    if (!(t > 0)) return `NACA ${digits}: thickness digits must be > 00`;
    if (m > 0 !== p > 0) return `NACA ${digits}: camber and its position must both be zero or both be non-zero`;
    const camber =
      m === 0
        ? flat
        : (x: number) =>
            x < p
              ? { y: (m / p ** 2) * (2 * p * x - x * x), slope: ((2 * m) / p ** 2) * (p - x) }
              : { y: (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x), slope: ((2 * m) / (1 - p) ** 2) * (p - x) };
    return { designation: `NACA ${digits}`, maxThickness: t, camber };
  }
  if (/^\d{5}$/.test(digits)) {
    const line = FIVE_DIGIT_MEAN_LINES[digits.slice(0, 3)];
    if (!line) return `NACA ${digits}: only the 230 mean line (e.g. 23012, 23015) is supported`;
    const t = Number(digits.slice(3)) / 100;
    if (!(t > 0)) return `NACA ${digits}: thickness digits must be > 00`;
    const [m, k1] = line;
    const camber = (x: number): { y: number; slope: number } =>
      x < m
        ? { y: (k1 / 6) * (x ** 3 - 3 * m * x * x + m * m * (3 - m) * x), slope: (k1 / 6) * (3 * x * x - 6 * m * x + m * m * (3 - m)) }
        : { y: ((k1 * m ** 3) / 6) * (1 - x), slope: -(k1 * m ** 3) / 6 };
    return { designation: `NACA ${digits}`, maxThickness: t, camber };
  }
  return `"${raw}" is not a NACA 4-digit (e.g. 2412) or 5-digit (e.g. 23012) designation`;
}

export const thicknessAt = (x: number, t: number, closedTrailingEdge: boolean): number =>
  5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - (closedTrailingEdge ? 0.1036 : 0.1015) * x ** 4);

/**
 * Ordinates from the upper trailing edge round the leading edge to the lower trailing edge (Selig order), cosine spacing,
 * `pointsPerSide` + 1 stations per surface; the leading edge point is shared.
 */
export function nacaOrdinates(
  section: NacaSection,
  pointsPerSide: number,
  closedTrailingEdge: boolean,
  spacing: 'cosine' | 'uniform' = 'cosine',
): Array<[number, number]> {
  const stations = Array.from({ length: pointsPerSide + 1 }, (_, index) =>
    spacing === 'cosine' ? (1 - Math.cos((Math.PI * index) / pointsPerSide)) / 2 : index / pointsPerSide,
  );
  const surface = (sign: 1 | -1): Array<[number, number]> =>
    stations.map((x) => {
      const yt = thicknessAt(x, section.maxThickness, closedTrailingEdge);
      const { y, slope } = section.camber(x);
      const theta = Math.atan(slope);
      return [x - sign * yt * Math.sin(theta), y + sign * yt * Math.cos(theta)];
    });
  const upper = surface(1).reverse();
  const lower = surface(-1).slice(1);
  return [...upper, ...lower];
}
