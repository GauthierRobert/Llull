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

/** Coarse pitches (mm) of ISO 261 / ISO 262 for the metric sizes M3-M20 the modelled-thread commands support. */
const ISO_COARSE_PITCH_MM: ReadonlyMap<number, number> = new Map([
  [3, 0.5],
  [4, 0.7],
  [5, 0.8],
  [6, 1],
  [8, 1.25],
  [10, 1.5],
  [12, 1.75],
  [14, 2],
  [16, 2],
  [18, 2.5],
  [20, 2.5],
]);
const ISO_METRIC_MIN_MM = 3;
const ISO_METRIC_MAX_MM = 20;
/** H of the ISO 68-1 fundamental triangle per unit pitch: sqrt(3) / 2. */
const H_PER_PITCH = Math.sqrt(3) / 2;

export interface IsoMetricThread extends ThreadDimensions {
  readonly designation: string;
  /** True when the pitch came from the ISO 261 coarse table (no explicit "xP"). */
  readonly coarse: boolean;
}

/**
 * Size and pitch of an ISO metric designation "M8" (coarse pitch of ISO 261) or "M8x1" (explicit, e.g. fine), M3-M20 only; any tolerance
 * suffix ("-6H") is ignored.
 * @failure not "M<d>" / "M<d>x<p>", diameter outside M3-M20, a size without a coarse pitch (M7, M9...) and no explicit pitch, pitch <= 0 or
 *   >= d / 2 -> the reason
 */
export function parseIsoMetric(designation: string): IsoMetricThread | string {
  const match = /^M(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?(?:-.*)?$/.exec(designation.trim());
  if (match === null) return `'${designation}' is not an ISO metric designation (M8 or M8x1)`;
  const major = Number(match[1]);
  if (!(major >= ISO_METRIC_MIN_MM && major <= ISO_METRIC_MAX_MM))
    return `M${match[1]} is outside the supported range M${ISO_METRIC_MIN_MM}-M${ISO_METRIC_MAX_MM}`;
  const explicit = match[2] === undefined ? undefined : Number(match[2]);
  const pitch = explicit ?? ISO_COARSE_PITCH_MM.get(major);
  if (pitch === undefined) return `M${match[1]} has no ISO 261 coarse pitch: give the pitch explicitly (M${match[1]}x1.5)`;
  if (!(pitch > 0) || pitch >= major / 2) return `pitch ${pitch} is not valid for M${match[1]} (must be > 0 and below half the diameter)`;
  return { designation: `M${match[1]}x${pitch}`, majorDiameterMm: major, pitchMm: pitch, coarse: explicit === undefined };
}

/** ISO 68-1 basic profile diameters for major diameter `d` and `pitch` (one length unit): d2 = d - 0.649519 P, d1 = d - 1.082532 P, H = 0.866025 P. */
export function isoBasicDiameters(major: number, pitch: number): { height: number; pitchDiameter: number; minorDiameter: number } {
  const height = H_PER_PITCH * pitch;
  return { height, pitchDiameter: major - 0.75 * height, minorDiameter: major - 1.25 * height };
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

export interface ExternalThreadForm {
  readonly pitch: number;
  readonly majorRadius: number;
  /** d1 / 2 of the basic profile (the groove bottom). */
  readonly minorRadius: number;
  /** Axial width of the groove cut into the bolt at `radius`: P/4 at the minor radius (root flat), 7P/8 at the major radius (crest flat P/8). */
  readonly widthAt: (radius: number) => number;
  /** Groove area in the axial plane between the minor and major radius. */
  readonly grooveArea: number;
  /** Radius of the groove area centroid. */
  readonly grooveCentroidRadius: number;
}

/** Basic external (bolt) thread profile of ISO 68-1 for `pitch` and `majorDiameter` in one length unit. */
export function externalThreadForm(pitch: number, majorDiameter: number): ExternalThreadForm {
  const majorRadius = majorDiameter / 2;
  const minorRadius = majorRadius - (5 / 8) * H_PER_PITCH * pitch;
  const widthAt = (radius: number): number => pitch / 4 + 2 * (radius - minorRadius) * TAN_30;
  const depth = majorRadius - minorRadius;
  const [narrow, wide] = [widthAt(minorRadius), widthAt(majorRadius)];
  const grooveArea = (depth * (wide + narrow)) / 2;
  const grooveCentroidRadius = minorRadius + (depth * (narrow + 2 * wide)) / (3 * (wide + narrow));
  return { pitch, majorRadius, minorRadius, widthAt, grooveArea, grooveCentroidRadius };
}

/** Volume the basic external thread removes from a cylinder of the major diameter over `length` (groove running out at both ends): groove area x helix length (Pappus). */
export function externalThreadRemovedVolume(form: ExternalThreadForm, length: number): number {
  return (2 * Math.PI * form.grooveCentroidRadius * form.grooveArea * length) / form.pitch;
}

/** Volume the basic internal thread removes over `length` of a plate: the minor-diameter bore plus groove area x helix length (Pappus). */
export function internalThreadRemovedVolume(form: InternalThreadForm, length: number): number {
  const bore = Math.PI * form.minorRadius ** 2 * length;
  return bore + (2 * Math.PI * form.grooveCentroidRadius * form.grooveArea * length) / form.pitch;
}
