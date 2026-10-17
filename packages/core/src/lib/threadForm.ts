/**
 * Thread geometry from a designation (07 FTR FR-FTR-20): pitch and major diameter of M / MJ / UN / UNJ designations, and the basic
 * internal (nut) 60 degree profile of ISO 68-1 / ASME B1.1: groove between the minor diameter D1 = D - 1.25 H and the major diameter D, with
 * H = (sqrt 3 / 2) P, a P/4 crest flat at D1 and a P/8 root flat at D.
 * @invariant the MJ / UNJ root radius of ISO 5855 / AS8879 is NOT applied: MJ and UNJ share the basic profile (`unverified` for those families)
 */

const MM_PER_INCH = 25.4;
const NUMBER = String.raw`\d+(?:\.\d+)?`;
const METRIC = new RegExp(String.raw`^(?:MJ|M)(${NUMBER})x(${NUMBER})`);
const INCH = new RegExp(String.raw`^(#\d+|\d+/\d+|\d*\.\d+|\d+)-(\d+)\s*UN`);

export interface ThreadDimensions {
  readonly pitchMm: number;
  readonly majorDiameterMm: number;
}

/** Inch size token ("#10", "1/4", ".1900", "1") in inches. */
function inchSize(token: string): number {
  if (token.startsWith('#')) return 0.06 + 0.013 * Number(token.slice(1));
  const [numerator, denominator] = token.split('/');
  return denominator === undefined ? Number(token) : Number(numerator) / Number(denominator);
}

/**
 * Pitch and major diameter, millimetres. "M6x1-6H" / "MJ6x1-4H5H" -> 1, 6; ".1900-32 UNJF-3B" -> 25.4/32, 4.826.
 * @failure a coarse "M6" (no pitch: needs the ISO 261 table), malformed or non-positive values -> null
 */
export function parseThreadDimensions(designation: string): ThreadDimensions | null {
  const metric = METRIC.exec(designation);
  const inch = metric === null ? INCH.exec(designation) : null;
  let result: ThreadDimensions | null = null;
  if (metric !== null) result = { majorDiameterMm: Number(metric[1]), pitchMm: Number(metric[2]) };
  else if (inch !== null) result = { majorDiameterMm: inchSize(inch[1] as string) * MM_PER_INCH, pitchMm: MM_PER_INCH / Number(inch[2]) };
  const valid = result !== null && Number.isFinite(result.pitchMm) && result.pitchMm > 0 && result.majorDiameterMm > 2 * result.pitchMm;
  return valid ? result : null;
}

export interface InternalThreadForm {
  readonly pitch: number;
  readonly majorRadius: number;
  /** D1 / 2 of the basic profile. */
  readonly minorRadius: number;
  /** Axial width of the groove at `radius` (60 degree included flank angle); P/8 at the major radius. */
  readonly widthAt: (radius: number) => number;
  /** Groove area in the axial plane between the minor and major radius. */
  readonly grooveArea: number;
  /** Radius of the groove area centroid. */
  readonly grooveCentroidRadius: number;
}

const TAN_30 = Math.tan(Math.PI / 6);

/** Basic internal thread profile for `pitch` and `majorDiameter` in one length unit. */
export function internalThreadForm(pitch: number, majorDiameter: number): InternalThreadForm {
  const height = (Math.sqrt(3) / 2) * pitch;
  const majorRadius = majorDiameter / 2;
  const minorRadius = majorRadius - (5 / 8) * height;
  const widthAt = (radius: number): number => pitch / 8 + 2 * (majorRadius - radius) * TAN_30;
  const depth = majorRadius - minorRadius;
  const [wide, narrow] = [widthAt(minorRadius), widthAt(majorRadius)];
  const grooveArea = (depth * (wide + narrow)) / 2;
  const grooveCentroidRadius = minorRadius + (depth * (wide + 2 * narrow)) / (3 * (wide + narrow));
  return { pitch, majorRadius, minorRadius, widthAt, grooveArea, grooveCentroidRadius };
}

/** Volume the basic internal thread removes over `length` of a plate: the minor-diameter bore plus groove area x helix length (Pappus). */
export function internalThreadRemovedVolume(form: InternalThreadForm, length: number): number {
  const bore = Math.PI * form.minorRadius ** 2 * length;
  return bore + (2 * Math.PI * form.grooveCentroidRadius * form.grooveArea * length) / form.pitch;
}
