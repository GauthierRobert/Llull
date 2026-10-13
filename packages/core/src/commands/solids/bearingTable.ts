/** Common rolling-bearing designations (ISO 15 boundary dimensions, mm): bore d, outer diameter D, width B. */

export const BEARING_TYPES = ['deep_groove_ball', 'spherical_roller', 'tapered_roller', 'cylindrical_roller'] as const;

export type BearingType = (typeof BEARING_TYPES)[number];

export interface BearingSize {
  readonly bore: number;
  readonly outerDiameter: number;
  readonly width: number;
  readonly type: BearingType;
}

type Row = readonly [designation: string, bore: number, outerDiameter: number, width: number];

function rows(type: BearingType, list: readonly Row[]): Array<[string, BearingSize]> {
  return list.map(([name, bore, outerDiameter, width]) => [name, { bore, outerDiameter, width, type }]);
}

const DEEP_GROOVE: readonly Row[] = [
  ['6000', 10, 26, 8],
  ['6001', 12, 28, 8],
  ['6002', 15, 32, 9],
  ['6003', 17, 35, 10],
  ['6004', 20, 42, 12],
  ['6005', 25, 47, 12],
  ['6006', 30, 55, 13],
  ['6007', 35, 62, 14],
  ['6008', 40, 68, 15],
  ['6009', 45, 75, 16],
  ['6010', 50, 80, 16],
  ['6200', 10, 30, 9],
  ['6201', 12, 32, 10],
  ['6202', 15, 35, 11],
  ['6203', 17, 40, 12],
  ['6204', 20, 47, 14],
  ['6205', 25, 52, 15],
  ['6206', 30, 62, 16],
  ['6207', 35, 72, 17],
  ['6208', 40, 80, 18],
  ['6209', 45, 85, 19],
  ['6210', 50, 90, 20],
  ['6211', 55, 100, 21],
  ['6212', 60, 110, 22],
  ['6300', 10, 35, 11],
  ['6301', 12, 37, 12],
  ['6302', 15, 42, 13],
  ['6303', 17, 47, 14],
  ['6304', 20, 52, 15],
  ['6305', 25, 62, 17],
  ['6306', 30, 72, 19],
  ['6307', 35, 80, 21],
  ['6308', 40, 90, 23],
  ['6309', 45, 100, 25],
  ['6310', 50, 110, 27],
];

const SPHERICAL_ROLLER: readonly Row[] = [
  ['22205', 25, 52, 18],
  ['22206', 30, 62, 20],
  ['22207', 35, 72, 23],
  ['22208', 40, 80, 23],
  ['22209', 45, 85, 23],
  ['22210', 50, 90, 23],
  ['22211', 55, 100, 25],
  ['22212', 60, 110, 28],
  ['22213', 65, 120, 31],
  ['22214', 70, 125, 31],
  ['22215', 75, 130, 31],
  ['22216', 80, 140, 33],
  ['22217', 85, 150, 36],
  ['22218', 90, 160, 40],
  ['22219', 95, 170, 43],
  ['22220', 100, 180, 46],
];

const TAPERED_ROLLER: readonly Row[] = [
  ['30204', 20, 47, 15.25],
  ['30205', 25, 52, 16.25],
  ['30206', 30, 62, 17.25],
  ['30207', 35, 72, 18.25],
  ['30208', 40, 80, 19.75],
  ['30209', 45, 85, 20.75],
  ['30210', 50, 90, 21.75],
  ['30211', 55, 100, 22.75],
  ['30212', 60, 110, 23.75],
];

const CYLINDRICAL_ROLLER: readonly Row[] = [
  ['NU204', 20, 47, 14],
  ['NU205', 25, 52, 15],
  ['NU206', 30, 62, 16],
  ['NU207', 35, 72, 17],
  ['NU208', 40, 80, 18],
  ['NU209', 45, 85, 19],
  ['NU210', 50, 90, 20],
  ['NU211', 55, 100, 21],
  ['NU212', 60, 110, 22],
  ['NU305', 25, 62, 17],
  ['NU306', 30, 72, 19],
];

/** Designation (upper-case, no spaces) -> boundary dimensions and type. */
export const BEARING_TABLE: ReadonlyMap<string, BearingSize> = new Map([
  ...rows('deep_groove_ball', DEEP_GROOVE),
  ...rows('spherical_roller', SPHERICAL_ROLLER),
  ...rows('tapered_roller', TAPERED_ROLLER),
  ...rows('cylindrical_roller', CYLINDRICAL_ROLLER),
]);

/** Look up a designation such as "6205", "nu 210" or "6205-2RS" (suffix after a dash/space is ignored). */
export function lookupBearing(designation: string): BearingSize | undefined {
  const key = designation.trim().toUpperCase().replace(/\s+/g, '');
  return BEARING_TABLE.get(key) ?? BEARING_TABLE.get(key.split(/[-/]/)[0] ?? '');
}
