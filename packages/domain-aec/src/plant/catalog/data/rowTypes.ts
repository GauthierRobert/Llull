/** Compact row shapes of the generated data modules (scripts/pipingCatalogGen.ts reads the 01 PSC validation pack into them). */

/** ASME B36.10M / B36.19M pipe row: NPS (number), schedule label, OD mm, nominal wall mm, grade A (two sources agree). */
export type PipeRow = readonly [nps: number, schedule: string, odMm: number, wallMm: number, verified: boolean];

/** B16.9 centre-to-end / run / length row by NPS (mm) with the pack source ids. */
export type FittingRow = readonly [nps: number, mm: number, verified: boolean, sources: string];

/** B16.5 weld-neck RF flange row: dimensions in mm, bolt diameter as the inch designation. */
export type FlangeB165Row = readonly [
  nps: string,
  ratingClass: number,
  odMm: number,
  thicknessMm: number,
  boltCircleMm: number,
  boltCount: number,
  boltDiameterIn: string,
  raisedFaceMm: number,
  thicknessVerified: boolean,
  patternVerified: boolean,
  odVerified: boolean,
];

/** EN 1092-1 weld-neck flange connection row: DN, PN, D, K, hole diameter, hole count, thickness (null when unsourced). */
export type FlangeEnRow = readonly [
  dn: number,
  pn: number,
  odMm: number,
  boltCircleMm: number,
  holeMm: number,
  holes: number,
  thicknessMm: number | null,
  odVerified: boolean,
  holesVerified: boolean,
];

/** One dimension of a gasket size (B16.20 spiral wound). */
export type GasketRow = readonly [nps: number, ratingClass: number, dim: string, mm: number, verified: boolean];

/** B16.10 face-to-face of a Class-rated flanged RF gate valve. */
export type ValveRow = readonly [nps: number, ratingClass: number, faceToFaceMm: number, verified: boolean];

/** B16.5 group 1.1 rating: class, upper temperature of the band (°C), bar gauge. */
export type RatingBarRow = readonly [ratingClass: number, temperatureC: number, bar: number, verified: boolean];

/** B16.5 group 1.1 rating in psig at a temperature in °F. */
export type RatingPsiRow = readonly [ratingClass: number, temperatureF: number, psi: number, verified: boolean];
