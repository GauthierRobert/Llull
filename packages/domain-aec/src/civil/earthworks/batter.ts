/**
 * Batter (side-slope) design level shared by earthworks, platform daylighting and road sections.
 * @layer domain-aec/civil
 * @pure
 */

/** Design level `distance` out from an edge at `elevation`: rises at 1/cutSlope in cut, falls at 1/fillSlope in fill. */
export function batterLevel(
  elevation: number,
  distance: number,
  mode: 'cut' | 'fill',
  cutSlope: number,
  fillSlope: number,
): number {
  return mode === 'cut' ? elevation + distance / cutSlope : elevation - distance / fillSlope;
}
