/**
 * EN 1991-1-4 external pressure coefficients cpe,10 of roofs, linearly interpolated on the pitch α:
 * flat roofs (§7.2.3 Tab. 7.2, sharp eaves), monopitch (Tab. 7.3a) and duopitch (Tab. 7.4a / 7.4b).
 * Each zone carries two coupled load-case sets: `suction` (the set with the large suction on the
 * windward zones F / G / H) and `pressure` (the alternative set, positive on the windward zones for
 * α ≥ 5° and the larger suction on the leeward zones). Where the standard gives a single value both
 * are equal. Sign convention: cpe < 0 is suction (uplift).
 * @layer domain-aec
 * @pure
 */

export type RoofType = 'flat' | 'duopitch' | 'monopitch';

/**
 * Wind direction θ in degrees. Duopitch: 0 across the ridge, 90 along it. Monopitch: 0 = wind on the
 * low eaves, 180 = wind on the high eaves, 90 along the eaves. Ignored for flat roofs.
 */
export type WindDirection = 0 | 90 | 180;

export type RoofZone = 'F' | 'Fup' | 'Flow' | 'G' | 'H' | 'I' | 'J';

export interface ZoneCpe {
  readonly suction: number;
  readonly pressure: number;
}

export type RoofCoefficients = Partial<Record<RoofZone, ZoneCpe>>;

export type CoefficientSet = keyof ZoneCpe;

/** Pitches below this (degrees) are treated as flat roofs (§7.2.3). */
export const FLAT_ROOF_LIMIT = 5;

/** Share of a leeward slope covered by the ridge strip J (e/10 on a slope about b/2 wide, e ≤ b). */
export const RIDGE_STRIP_SHARE = 0.1;

type Row = {
  readonly pitch: number;
  readonly zones: Partial<Record<RoofZone, readonly [number, number]>>;
};

/** Tab. 7.2, sharp eaves: F −1.8, G −1.2, H −0.7, I ±0.2 (−0.2 in the suction set, +0.2 in the pressure set). */
const FLAT: Row['zones'] = {
  F: [-1.8, -1.8],
  G: [-1.2, -1.2],
  H: [-0.7, -0.7],
  I: [-0.2, 0.2],
};

/** Tab. 7.4a (duopitch, θ = 0°), cpe,10: [suction set, pressure set] per zone. */
const DUOPITCH_ACROSS: readonly Row[] = [
  {
    pitch: -5,
    zones: { F: [-2.3, -2.3], G: [-1.2, -1.2], H: [-0.8, -0.8], I: [-0.6, -0.6], J: [-0.6, -0.6] },
  },
  {
    pitch: 5,
    zones: { F: [-1.7, 0], G: [-1.2, 0], H: [-0.6, 0], I: [-0.6, -0.6], J: [0.2, -0.6] },
  },
  {
    pitch: 15,
    zones: { F: [-0.9, 0.2], G: [-0.8, 0.2], H: [-0.3, 0.2], I: [-0.4, 0], J: [-1, 0] },
  },
  {
    pitch: 30,
    zones: { F: [-0.5, 0.7], G: [-0.5, 0.7], H: [-0.2, 0.4], I: [-0.4, 0], J: [-0.5, 0] },
  },
  { pitch: 45, zones: { F: [0, 0.7], G: [0, 0.7], H: [0, 0.6], I: [-0.2, 0], J: [-0.3, 0] } },
];

const single = (...values: number[]): Array<readonly [number, number]> =>
  values.map((value) => [value, value] as const);

/** Tab. 7.4b (duopitch, θ = 90°), cpe,10, one set. Held at the 5° values below 5°. */
const DUOPITCH_ALONG: readonly Row[] = [
  { pitch: 5, zones: zonesOf(['F', 'G', 'H', 'I'], single(-1.6, -1.3, -0.7, -0.6)) },
  { pitch: 15, zones: zonesOf(['F', 'G', 'H', 'I'], single(-1.3, -1.3, -0.6, -0.5)) },
  { pitch: 30, zones: zonesOf(['F', 'G', 'H', 'I'], single(-1.1, -1.4, -0.8, -0.5)) },
  { pitch: 45, zones: zonesOf(['F', 'G', 'H', 'I'], single(-1.1, -1.4, -0.9, -0.5)) },
];

/** Tab. 7.3a (monopitch, θ = 0°, wind on the low eaves): same F / G / H as the duopitch windward slope. */
const MONOPITCH_LOW_EAVES: readonly Row[] = [
  { pitch: 5, zones: { F: [-1.7, 0], G: [-1.2, 0], H: [-0.6, 0] } },
  { pitch: 15, zones: { F: [-0.9, 0.2], G: [-0.8, 0.2], H: [-0.3, 0.2] } },
  { pitch: 30, zones: { F: [-0.5, 0.7], G: [-0.5, 0.7], H: [-0.2, 0.4] } },
  { pitch: 45, zones: { F: [0, 0.7], G: [0, 0.7], H: [0, 0.6] } },
];

/** Tab. 7.3a (monopitch, θ = 180°, wind on the high eaves), one set. */
const MONOPITCH_HIGH_EAVES: readonly Row[] = [
  { pitch: 5, zones: zonesOf(['F', 'G', 'H'], single(-2.3, -1.3, -0.8)) },
  { pitch: 15, zones: zonesOf(['F', 'G', 'H'], single(-2.5, -1.3, -0.9)) },
  { pitch: 30, zones: zonesOf(['F', 'G', 'H'], single(-1.1, -1.4, -0.8)) },
  { pitch: 45, zones: zonesOf(['F', 'G', 'H'], single(-0.6, -1.2, -0.8)) },
];

/**
 * Tab. 7.3a (monopitch, θ = 90°), one set. APPROXIMATE: the 5-15° values are those the purlin check
 * has always used (F −1.6 for both F_up and F_low, G −1.8, H −0.6, I −0.5); the standard's 30° and 45°
 * rows are not reproduced from memory, so the 15° values are held (conservative).
 */
const MONOPITCH_ALONG: readonly Row[] = [5, 15, 30, 45].map((pitch) => ({
  pitch,
  zones: zonesOf(['Fup', 'Flow', 'G', 'H', 'I'], single(-1.6, -1.6, -1.8, -0.6, -0.5)),
}));

function zonesOf(
  names: readonly RoofZone[],
  values: ReadonlyArray<readonly [number, number]>,
): Row['zones'] {
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

function interpolate(rows: readonly Row[], pitchDeg: number): RoofCoefficients {
  const first = rows[0] as Row;
  const last = rows[rows.length - 1] as Row;
  const pitch = Math.min(Math.max(pitchDeg, first.pitch), last.pitch);
  const upperIndex = Math.max(
    1,
    rows.findIndex((row) => row.pitch >= pitch),
  );
  const lower = rows[upperIndex - 1] as Row;
  const upper = rows[upperIndex] as Row;
  const t = (pitch - lower.pitch) / (upper.pitch - lower.pitch);
  const blend = (a: number, b: number): number => a * (1 - t) + b * t;
  return Object.fromEntries(
    (Object.entries(lower.zones) as Array<[RoofZone, readonly [number, number]]>).map(
      ([zone, [suction, pressure]]) => {
        const [upperSuction, upperPressure] = upper.zones[zone] ?? [suction, pressure];
        return [
          zone,
          { suction: blend(suction, upperSuction), pressure: blend(pressure, upperPressure) },
        ];
      },
    ),
  );
}

const asZones = (zones: Row['zones']): RoofCoefficients =>
  Object.fromEntries(
    (Object.entries(zones) as Array<[RoofZone, readonly [number, number]]>).map(
      ([zone, [suction, pressure]]) => [zone, { suction, pressure }],
    ),
  );

/**
 * cpe,10 of every roof zone at pitch α (degrees) and wind direction θ.
 * Flat roofs (and 0° ≤ α < 5° of the other types) use Tab. 7.2; α is clamped to the table range.
 * @invariant duopitch θ = 0° zones F G H I J, θ = 90° F G H I; monopitch θ = 0° / 180° F G H, θ = 90° Fup Flow G H I; flat F G H I
 */
export function roofCoefficients(
  roofType: RoofType,
  pitchDeg: number,
  direction: WindDirection,
): RoofCoefficients {
  if (roofType === 'flat' || (pitchDeg >= 0 && pitchDeg < FLAT_ROOF_LIMIT)) return asZones(FLAT);
  if (roofType === 'duopitch') {
    return interpolate(direction === 90 ? DUOPITCH_ALONG : DUOPITCH_ACROSS, pitchDeg);
  }
  if (direction === 90) return interpolate(MONOPITCH_ALONG, pitchDeg);
  return interpolate(direction === 180 ? MONOPITCH_HIGH_EAVES : MONOPITCH_LOW_EAVES, pitchDeg);
}

export type RoofSlope = 'windward' | 'leeward';

/**
 * Frame-average cpe of a roof slope (the frame sees the whole slope, not the F / G corner zones).
 * Windward slope: zone H. Leeward slope: area-weighted zones I and J (J = ridge strip,
 * `RIDGE_STRIP_SHARE`). Flat roof: windward half H, leeward half I. Monopitch has one slope: zone H of
 * the direction (θ = 0° low eaves, θ = 180° high eaves), `slope` ignored.
 */
export function frameRoofAverage(
  roofType: RoofType,
  pitchDeg: number,
  direction: 0 | 180,
  set: CoefficientSet,
  slope: RoofSlope = 'windward',
): number {
  const zones = roofCoefficients(roofType, pitchDeg, direction);
  const cpe = (zone: RoofZone): number => zones[zone]?.[set] ?? 0;
  if (roofType === 'monopitch' && !(pitchDeg >= 0 && pitchDeg < FLAT_ROOF_LIMIT)) return cpe('H');
  if (slope === 'windward') return cpe('H');
  return zones.J ? (1 - RIDGE_STRIP_SHARE) * cpe('I') + RIDGE_STRIP_SHARE * cpe('J') : cpe('I');
}
