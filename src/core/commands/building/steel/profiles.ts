/**
 * Steel section catalogue (European standard sections, dimensions in mm) and exact outlines.
 * Masses: catalogue values for hot-rolled I / U sections, computed (ρ = 7850 kg/m³, sharp corners)
 * for hollow sections, angles and cold-formed channels.
 * @layer core/commands/building/steel
 * @pure
 */

import type { Vec2 } from '../../../model/types';

export type ProfileShape = 'I' | 'U' | 'C' | 'SHS' | 'RHS' | 'CHS' | 'L';

export interface SteelProfile {
  readonly name: string;
  readonly family: 'IPE' | 'HEA' | 'HEB' | 'UPN' | 'C' | 'SHS' | 'RHS' | 'CHS' | 'L';
  readonly shape: ProfileShape;
  /** Overall depth (outside diameter for CHS), mm. */
  readonly h: number;
  /** Overall width, mm. */
  readonly b: number;
  /** Web thickness (wall thickness for hollow / cold-formed / angles), mm. */
  readonly tw: number;
  /** Flange thickness (= tw for hollow / cold-formed / angles), mm. */
  readonly tf: number;
  /** Lip length of cold-formed C sections, mm. */
  readonly lip: number;
  /** Mass per metre, kg/m. */
  readonly massPerMetre: number;
  /** Cross-section area, mm². */
  readonly area: number;
  /** Painted (outer) perimeter, mm. */
  readonly perimeter: number;
}

const STEEL_DENSITY_KG_PER_MM2_M = 0.00785;

type Row = readonly [string, number, number, number, number, number];

function rolled(family: 'IPE' | 'HEA' | 'HEB', rows: ReadonlyArray<Row>): SteelProfile[] {
  return rows.map(([size, h, b, tw, tf, mass]) => ({
    name: `${family}${size}`,
    family,
    shape: 'I',
    h,
    b,
    tw,
    tf,
    lip: 0,
    massPerMetre: mass,
    area: mass / STEEL_DENSITY_KG_PER_MM2_M,
    perimeter: 2 * h + 4 * b - 2 * tw,
  }));
}

const IPE = rolled('IPE', [
  ['80', 80, 46, 3.8, 5.2, 6.0],
  ['100', 100, 55, 4.1, 5.7, 8.1],
  ['120', 120, 64, 4.4, 6.3, 10.4],
  ['140', 140, 73, 4.7, 6.9, 12.9],
  ['160', 160, 82, 5.0, 7.4, 15.8],
  ['180', 180, 91, 5.3, 8.0, 18.8],
  ['200', 200, 100, 5.6, 8.5, 22.4],
  ['220', 220, 110, 5.9, 9.2, 26.2],
  ['240', 240, 120, 6.2, 9.8, 30.7],
  ['270', 270, 135, 6.6, 10.2, 36.1],
  ['300', 300, 150, 7.1, 10.7, 42.2],
  ['330', 330, 160, 7.5, 11.5, 49.1],
  ['360', 360, 170, 8.0, 12.7, 57.1],
  ['400', 400, 180, 8.6, 13.5, 66.3],
  ['450', 450, 190, 9.4, 14.6, 77.6],
  ['500', 500, 200, 10.2, 16.0, 90.7],
  ['550', 550, 210, 11.1, 17.2, 106],
  ['600', 600, 220, 12.0, 19.0, 122],
]);

const HEA = rolled('HEA', [
  ['100', 96, 100, 5, 8, 16.7],
  ['120', 114, 120, 5, 8, 19.9],
  ['140', 133, 140, 5.5, 8.5, 24.7],
  ['160', 152, 160, 6, 9, 30.4],
  ['180', 171, 180, 6, 9.5, 35.5],
  ['200', 190, 200, 6.5, 10, 42.3],
  ['220', 210, 220, 7, 11, 50.5],
  ['240', 230, 240, 7.5, 12, 60.3],
  ['260', 250, 260, 7.5, 12.5, 68.2],
  ['280', 270, 280, 8, 13, 76.4],
  ['300', 290, 300, 8.5, 14, 88.3],
  ['320', 310, 300, 9, 15.5, 97.6],
  ['340', 330, 300, 9.5, 16.5, 105],
  ['360', 350, 300, 10, 17.5, 112],
  ['400', 390, 300, 11, 19, 125],
  ['450', 440, 300, 11.5, 21, 140],
  ['500', 490, 300, 12, 23, 155],
]);

const HEB = rolled('HEB', [
  ['100', 100, 100, 6, 10, 20.4],
  ['120', 120, 120, 6.5, 11, 26.7],
  ['140', 140, 140, 7, 12, 33.7],
  ['160', 160, 160, 8, 13, 42.6],
  ['180', 180, 180, 8.5, 14, 51.2],
  ['200', 200, 200, 9, 15, 61.3],
  ['220', 220, 220, 9.5, 16, 71.5],
  ['240', 240, 240, 10, 17, 83.2],
  ['260', 260, 260, 10, 17.5, 93.0],
  ['280', 280, 280, 10.5, 18, 103],
  ['300', 300, 300, 11, 19, 117],
  ['320', 320, 300, 11.5, 20.5, 127],
  ['340', 340, 300, 12, 21.5, 134],
  ['360', 360, 300, 12.5, 22.5, 142],
  ['400', 400, 300, 13.5, 24, 155],
  ['450', 450, 300, 14, 26, 171],
  ['500', 500, 300, 14.5, 28, 187],
]);

const UPN: SteelProfile[] = (
  [
    ['80', 80, 45, 6, 8, 8.64],
    ['100', 100, 50, 6, 8.5, 10.6],
    ['120', 120, 55, 7, 9, 13.4],
    ['140', 140, 60, 7, 10, 16.0],
    ['160', 160, 65, 7.5, 10.5, 18.8],
    ['180', 180, 70, 8, 11, 22.0],
    ['200', 200, 75, 8.5, 11.5, 25.3],
    ['220', 220, 80, 9, 12.5, 29.4],
    ['240', 240, 85, 9.5, 13, 33.2],
    ['260', 260, 90, 10, 14, 37.9],
    ['300', 300, 100, 10, 16, 46.2],
  ] as const
).map(([size, h, b, tw, tf, mass]) => ({
  name: `UPN${size}`,
  family: 'UPN' as const,
  shape: 'U' as const,
  h,
  b,
  tw,
  tf,
  lip: 0,
  massPerMetre: mass,
  area: mass / STEEL_DENSITY_KG_PER_MM2_M,
  perimeter: 2 * h + 4 * b - 2 * tw,
}));

function computed(base: Omit<SteelProfile, 'massPerMetre' | 'area'>, area: number): SteelProfile {
  const rounded = Math.round(area * STEEL_DENSITY_KG_PER_MM2_M * 100) / 100;
  return { ...base, area, massPerMetre: rounded };
}

const SHS: SteelProfile[] = (
  [
    [50, 3],
    [60, 4],
    [80, 4],
    [100, 5],
    [120, 6],
    [140, 6],
    [150, 8],
    [200, 8],
    [200, 10],
    [250, 10],
    [300, 10],
  ] as const
).map(([b, t]) =>
  computed(
    {
      name: `SHS${b}x${t}`,
      family: 'SHS',
      shape: 'SHS',
      h: b,
      b,
      tw: t,
      tf: t,
      lip: 0,
      perimeter: 4 * b,
    },
    4 * t * (b - t),
  ),
);

const RHS: SteelProfile[] = (
  [
    [100, 50, 4],
    [120, 60, 5],
    [150, 100, 6],
    [200, 100, 6],
    [250, 150, 8],
    [300, 200, 10],
  ] as const
).map(([h, b, t]) =>
  computed(
    {
      name: `RHS${h}x${b}x${t}`,
      family: 'RHS',
      shape: 'RHS',
      h,
      b,
      tw: t,
      tf: t,
      lip: 0,
      perimeter: 2 * (h + b),
    },
    2 * t * (h + b - 2 * t),
  ),
);

const CHS: SteelProfile[] = (
  [
    [48.3, 3.2],
    [60.3, 3.2],
    [76.1, 3.6],
    [88.9, 4],
    [114.3, 5],
    [139.7, 5],
    [168.3, 6.3],
    [219.1, 8],
    [273, 10],
  ] as const
).map(([d, t]) =>
  computed(
    {
      name: `CHS${d}x${t}`,
      family: 'CHS',
      shape: 'CHS',
      h: d,
      b: d,
      tw: t,
      tf: t,
      lip: 0,
      perimeter: Math.PI * d,
    },
    (Math.PI * (d * d - (d - 2 * t) ** 2)) / 4,
  ),
);

const ANGLES: SteelProfile[] = (
  [
    [40, 4],
    [50, 5],
    [60, 6],
    [70, 7],
    [80, 8],
    [90, 9],
    [100, 10],
    [120, 12],
    [150, 15],
  ] as const
).map(([b, t]) =>
  computed(
    {
      name: `L${b}x${t}`,
      family: 'L',
      shape: 'L',
      h: b,
      b,
      tw: t,
      tf: t,
      lip: 0,
      perimeter: 4 * b,
    },
    t * (2 * b - t),
  ),
);

const COLD_FORMED: SteelProfile[] = (
  [
    [150, 65, 15, 2.0],
    [200, 75, 20, 2.0],
    [200, 75, 20, 2.5],
    [250, 75, 20, 2.5],
    [300, 90, 25, 3.0],
  ] as const
).map(([h, b, lip, t]) =>
  computed(
    {
      name: `C${h}x${b}x${t.toFixed(1)}`,
      family: 'C',
      shape: 'C',
      h,
      b,
      tw: t,
      tf: t,
      lip,
      perimeter: 2 * (h + 2 * b + 2 * lip),
    },
    t * (h + 2 * b + 2 * lip - 4 * t),
  ),
);

export const STEEL_PROFILES: ReadonlyArray<SteelProfile> = [
  ...IPE,
  ...HEA,
  ...HEB,
  ...UPN,
  ...COLD_FORMED,
  ...SHS,
  ...RHS,
  ...CHS,
  ...ANGLES,
];

const BY_NAME = new Map(STEEL_PROFILES.map((profile) => [profile.name.toUpperCase(), profile]));

/** Case- and space-insensitive lookup ("ipe 300", "HEA200", "shs100x5"). */
export function findProfile(name: string): SteelProfile | undefined {
  return BY_NAME.get(name.replace(/\s+/g, '').toUpperCase());
}

export interface ProfileOutline {
  /** Outer boundary, counter-clockwise, mm, centred on the bounding box; +y = depth (h), +x = width (b). */
  readonly outer: Vec2[];
  readonly holes: Vec2[][];
}

const CIRCLE_SEGMENTS = 20;

function circle(radius: number, clockwise: boolean): Vec2[] {
  const points = Array.from({ length: CIRCLE_SEGMENTS }, (_, index): Vec2 => {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  return clockwise ? points.reverse() : points;
}

function rectangle(width: number, height: number, clockwise = false): Vec2[] {
  const [x, y] = [width / 2, height / 2];
  const points: Vec2[] = [
    [-x, -y],
    [x, -y],
    [x, y],
    [-x, y],
  ];
  return clockwise ? points.reverse() : points;
}

/** Exact section outline (root radii omitted). */
export function profileOutline(profile: SteelProfile): ProfileOutline {
  const { h, b, tw, tf, lip } = profile;
  const [x, y] = [b / 2, h / 2];
  switch (profile.shape) {
    case 'I':
      return {
        outer: [
          [-x, -y],
          [x, -y],
          [x, -y + tf],
          [tw / 2, -y + tf],
          [tw / 2, y - tf],
          [x, y - tf],
          [x, y],
          [-x, y],
          [-x, y - tf],
          [-tw / 2, y - tf],
          [-tw / 2, -y + tf],
          [-x, -y + tf],
        ],
        holes: [],
      };
    case 'U':
      return {
        outer: [
          [-x, -y],
          [x, -y],
          [x, -y + tf],
          [-x + tw, -y + tf],
          [-x + tw, y - tf],
          [x, y - tf],
          [x, y],
          [-x, y],
        ],
        holes: [],
      };
    case 'C':
      return {
        outer: [
          [-x, -y],
          [x, -y],
          [x, -y + lip],
          [x - tw, -y + lip],
          [x - tw, -y + tf],
          [-x + tw, -y + tf],
          [-x + tw, y - tf],
          [x - tw, y - tf],
          [x - tw, y - lip],
          [x, y - lip],
          [x, y],
          [-x, y],
        ],
        holes: [],
      };
    case 'L':
      return {
        outer: [
          [-x, -y],
          [x, -y],
          [x, -y + tf],
          [-x + tw, -y + tf],
          [-x + tw, y],
          [-x, y],
        ],
        holes: [],
      };
    case 'SHS':
    case 'RHS':
      return { outer: rectangle(b, h), holes: [rectangle(b - 2 * tw, h - 2 * tw, true)] };
    case 'CHS':
      return { outer: circle(h / 2, false), holes: [circle(h / 2 - tw, true)] };
  }
}
