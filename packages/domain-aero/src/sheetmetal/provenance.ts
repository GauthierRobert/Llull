/** Sources of the formed-feature allowances that no published table backs (FR-FTR-10, 12: NOT VERIFIED practice); results carrying them are unverified. */

export const FLANGED_HOLE_SOURCE =
  'flat hole radius = tangent-circle radius - bend allowance alpha*(R+K*T) - wall length (radial strip, no circumferential stretch); stretch flange, approximate, not verified against a published table';

export const HEM_SOURCE =
  'hem developed length = pi*(gap/2+K*T) + leg: the neutral-surface bend allowance extended to 180 degrees (R = gap/2, 0 for a closed hem); not verified against a published hem allowance table';
