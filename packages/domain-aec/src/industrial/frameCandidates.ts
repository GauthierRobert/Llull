/**
 * Frame candidates of a level: rafters of one plane chained by touching / overlapping x-ranges,
 * grouped into halls for tributary widths. Lengths in mm.
 * @layer domain-aec
 * @pure
 */

import type { SteelMemberElement } from '@core/model/building';

export interface FrameCandidate {
  readonly y: number;
  range: [number, number];
  readonly rafters: SteelMemberElement[];
}

export function frameCandidates(
  rafters: ReadonlyArray<SteelMemberElement>,
  mm: (value: number) => number,
  tolerance: number,
): { candidates: FrameCandidate[]; tributaryOf: (candidate: FrameCandidate) => number } {
  const planeOf = (member: SteelMemberElement): number => Math.round(mm(member.start[1]));
  const xRange = (member: SteelMemberElement): [number, number] => [
    Math.min(mm(member.start[0]), mm(member.end[0])),
    Math.max(mm(member.start[0]), mm(member.end[0])),
  ];
  const candidates: FrameCandidate[] = [];
  for (const y of [...new Set(rafters.map(planeOf))].sort((a, b) => a - b)) {
    const inPlane = rafters
      .filter((rafter) => planeOf(rafter) === y)
      .sort((a, b) => xRange(a)[0] - xRange(b)[0]);
    for (const rafter of inPlane) {
      const [low, high] = xRange(rafter);
      const last = candidates[candidates.length - 1];
      if (last && last.y === y && low <= last.range[1] + tolerance) {
        last.range = [last.range[0], Math.max(last.range[1], high)];
        last.rafters.push(rafter);
      } else {
        candidates.push({ y, range: [low, high], rafters: [rafter] });
      }
    }
  }
  // Halls: candidates (across planes) whose x-ranges overlap; tributary widths per hall.
  const hallOf = new Map<FrameCandidate, FrameCandidate[]>();
  for (const candidate of candidates) {
    const hall = [...new Set(hallOf.values())].find((hallMembers) =>
      hallMembers.some(
        (other) => candidate.range[0] < other.range[1] && candidate.range[1] > other.range[0],
      ),
    );
    if (hall) {
      hall.push(candidate);
      hallOf.set(candidate, hall);
    } else {
      hallOf.set(candidate, [candidate]);
    }
  }
  const tributaryOf = (candidate: FrameCandidate): number => {
    const ys = [...new Set((hallOf.get(candidate) ?? [candidate]).map((other) => other.y))].sort(
      (a, b) => a - b,
    );
    const index = ys.indexOf(candidate.y);
    return ((ys[index + 1] ?? candidate.y) - (ys[index - 1] ?? candidate.y)) / 2;
  };
  return { candidates, tributaryOf };
}
