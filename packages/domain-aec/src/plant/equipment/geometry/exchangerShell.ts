/**
 * Shell segments of an exchanger (plant 03 EQP-FU2): one cylinder for the E, F, G, H, J, X shells; for the TEMA K kettle the restricted cylinder at the
 * tubesheet, a cone and the enlarged cylinder. A segment spans axial x `from..to` (front to rear) with inside radius `rFrom` -> `rTo` and a radial wall
 * `thickness`. Closed forms only: a cylinder is a cone of equal radii.
 */

export interface ShellSegment {
  readonly name: 'shell' | 'kettleTransition' | 'kettleShell';
  readonly from: number;
  readonly to: number;
  readonly rFrom: number;
  readonly rTo: number;
  readonly thickness: number;
}

/** Volume and centroid (axial x) of a solid frustum of base radius `a` at `from` and `b` at `to`. */
function frustum(a: number, b: number, from: number, to: number): { volume: number; centroid: number } {
  const h = to - from;
  const sum = a * a + a * b + b * b;
  return { volume: (Math.PI * h * sum) / 3, centroid: sum === 0 ? from + h / 2 : from + (h * (a * a + 2 * a * b + 3 * b * b)) / (4 * sum) };
}

const isCylinder = (segment: ShellSegment): boolean => segment.rFrom === segment.rTo;

/** Inside (fluid) volume and centroid x of a segment. */
export function segmentInside(segment: ShellSegment): { volume: number; centroid: number } {
  if (isCylinder(segment))
    return { volume: Math.PI * segment.rFrom * segment.rFrom * (segment.to - segment.from), centroid: (segment.from + segment.to) / 2 };
  return frustum(segment.rFrom, segment.rTo, segment.from, segment.to);
}

/** Fluid volume of a segment minus the outside volume of `tubesOutside` (tube cross-section sum) over its length. A cylinder is (pi R^2 - tubes) x length. */
export function segmentFluidVolume(segment: ShellSegment, tubesOutside: number): number {
  const length = segment.to - segment.from;
  if (isCylinder(segment)) return (Math.PI * segment.rFrom * segment.rFrom - tubesOutside) * length;
  return segmentInside(segment).volume - tubesOutside * length;
}

/** Metal volume and centroid x of a segment: a cylinder is pi ((R + t)^2 - R^2) x length; a cone is the frustum offset radially by the thickness minus the inside frustum (exact difference of solids). */
export function segmentMetal(segment: ShellSegment): { volume: number; centroid: number } {
  if (isCylinder(segment)) {
    const outer = segment.rFrom + segment.thickness;
    return {
      volume: Math.PI * (outer * outer - segment.rFrom * segment.rFrom) * (segment.to - segment.from),
      centroid: (segment.from + segment.to) / 2,
    };
  }
  const outer = frustum(segment.rFrom + segment.thickness, segment.rTo + segment.thickness, segment.from, segment.to);
  const inner = segmentInside(segment);
  const volume = outer.volume - inner.volume;
  return { volume, centroid: volume === 0 ? inner.centroid : (outer.volume * outer.centroid - inner.volume * inner.centroid) / volume };
}

/** Inside radius and wall of the shell at axial x (a point outside the shell is clamped to its end). */
export function shellWallAt(segments: readonly ShellSegment[], x: number): { inside: number; thickness: number } {
  const last = segments[segments.length - 1] as ShellSegment;
  const segment = segments.find((candidate) => x <= candidate.to) ?? last;
  const run = segment.to - segment.from;
  const t = run <= 0 ? 0 : Math.min(1, Math.max(0, (x - segment.from) / run));
  return { inside: segment.rFrom + t * (segment.rTo - segment.rFrom), thickness: segment.thickness };
}
