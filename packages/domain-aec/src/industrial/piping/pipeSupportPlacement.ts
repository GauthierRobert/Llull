/**
 * Where supports go along a pipe for a maximum spacing: one near each free end and bend, then equal
 * subdivisions of every longer stretch. Positions are arc lengths in mm along the centreline.
 * @layer domain-aec
 * @pure
 */

import { RISER_SLOPE, arcLengths, pointAtArc } from './routeSupport';
import { SAME_SUPPORT_DISTANCE, type EndCarrier, type PipeRun } from './pipeSupportLayout';

/** Largest distance of an end / bend support from the end / bend, mm (a quarter of the spacing below that). */
const MAX_CORNER_OFFSET = 300;

/** Whether a shoe or hanger can sit at arc length `arc` (the segment there is not a riser). */
export function isPlaceable(run: PipeRun, arc: number): boolean {
  const at = pointAtArc(run.points, arc);
  return at !== null && Math.abs(at.direction[2]) <= RISER_SLOPE;
}

/**
 * Arc lengths of new supports so that no stretch between supports (or carried ends) exceeds
 * `spacing`, given `existing` support arcs. A free end gets a support `offset` from it, every bend
 * one `offset` along its longer leg (`offset` = min(300 mm, spacing / 4)).
 * @invariant results are placeable, ≥ 100 mm from each other and from `existing`, ascending
 */
export function autoSupportArcs(
  run: PipeRun,
  carriers: readonly [EndCarrier | null, EndCarrier | null],
  existing: ReadonlyArray<number>,
  spacing: number,
): number[] {
  const length = run.lengthMm;
  const offset = Math.min(MAX_CORNER_OFFSET, spacing / 4);
  const chosen: number[] = [...existing];
  const add = (arc: number): void => {
    const clamped = Math.min(length, Math.max(0, arc));
    if (
      isPlaceable(run, clamped) &&
      chosen.every((other) => Math.abs(other - clamped) >= SAME_SUPPORT_DISTANCE)
    ) {
      chosen.push(clamped);
    }
  };
  const nodes = arcLengths(run.points);
  if (carriers[0] === null) add(Math.min(offset, length / 2));
  if (carriers[1] === null) add(Math.max(length - offset, length / 2));
  nodes.slice(1, -1).forEach((bend, index) => {
    const before = bend - (nodes[index] as number);
    const after = (nodes[index + 2] as number) - bend;
    add(after >= before ? bend + Math.min(offset, after / 2) : bend - Math.min(offset, before / 2));
  });
  const fixed = [...(carriers[0] === null ? [] : [0]), ...(carriers[1] === null ? [] : [length])];
  const stations = [...fixed, ...chosen].sort((a, b) => a - b);
  for (let index = 0; index + 1 < stations.length; index++) {
    const [from, to] = [stations[index] as number, stations[index + 1] as number];
    const parts = Math.ceil((to - from) / spacing - 1e-9);
    for (let part = 1; part < parts; part++) add(from + ((to - from) * part) / parts);
  }
  return chosen.filter((arc) => !existing.includes(arc)).sort((a, b) => a - b);
}
