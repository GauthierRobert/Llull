/**
 * Dimensions the router reads until the 01 PSC catalogue lands (02 RTE §2.A, "spec through a port"): pipe OD from the industrial
 * `PIPE_SIZES` table and the long-radius 90° elbow centre-to-end A of ASME B16.9 (grade-A rows of
 * docs/plant/02-spec-driven-routing/validation/data/b16_9_fitting_dimensions.json, sources S7, S8, S9). Never a formula for a standard
 * part (VC-RTE-15). Results that use these rows say so (`unverified`, AF-32) because the line's spec is not resolved yet.
 */

import { outsideDiameterMm } from '../../industrial/piping/pipeSizes';

/** ASME B16.9 LR 90° elbow centre-to-end A (mm) by DN: NPS 2, 3, 4, 6, 8. */
const ELBOW_90_LR_A_MM: Readonly<Record<number, number>> = { 50: 76, 80: 114, 100: 152, 150: 229, 200: 305 };

export const ELBOW_SOURCE = 'ASME B16.9 LR 90 A (02 RTE validation b16_9_fitting_dimensions.json, S7/S8/S9)';

/** Pipe outside diameter (mm) of `dn`, or null when not tabulated. */
export const pipeOutsideDiameter = (dn: number): number | null => outsideDiameterMm(dn);

/** Centre-to-end of the LR 90° elbow of `dn` (mm), or null when no row exists. */
export const elbowCentreToEnd = (dn: number): number | null => ELBOW_90_LR_A_MM[dn] ?? null;
