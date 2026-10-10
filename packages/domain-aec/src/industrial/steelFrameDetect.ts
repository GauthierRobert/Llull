/**
 * Planar moment frames of a steel structure: columns and beams in one vertical plane joined by rigid
 * (moment) beam-to-column joints. A frame beam keeps its pinned ends (released in the frame model).
 * @layer domain-aec
 * @pure
 */

import type { BeamResult } from './steelFraming';
import type { SteelBar } from './steelMemberBars';
import { metres } from './steelMemberRows';

/** Horizontal direction a frame resists: 'Y' for a frame in a plane x = const, 'X' for y = const. */
export type FrameDirection = 'X' | 'Y';

export interface MomentFrame {
  readonly label: string;
  readonly direction: FrameDirection;
  /** Plane coordinate, mm (x for direction Y, y for direction X). */
  readonly coordinate: number;
  readonly columns: SteelBar[];
  /** Beams with at least one rigid joint, in model order. */
  readonly beams: BeamResult[];
}

/** A solved frame as lateral system: the top of steel of its beams decides the storeys it stabilises. */
export interface FrameCoverage {
  readonly direction: FrameDirection;
  readonly beamTops: number[];
}

interface FrameDetection {
  readonly frames: MomentFrame[];
  /** Beam id → why its rigid joint(s) cannot be modelled (the beam is not analysed). */
  readonly rejected: Map<string, string>;
  readonly warnings: string[];
}

/** A beam this close to the X or Y direction in plan lies in a vertical plane there, mm. */
const PLANE_TOLERANCE = 50;
const PLANE_SNAP = 100;

interface Candidate {
  readonly beam: BeamResult;
  readonly direction: FrameDirection;
  readonly coordinate: number;
  readonly columnIds: string[];
}

function planeOf(bar: SteelBar): { direction: FrameDirection; coordinate: number } | null {
  const dx = Math.abs(bar.end[0] - bar.start[0]);
  const dy = Math.abs(bar.end[1] - bar.start[1]);
  if (dy <= PLANE_TOLERANCE && dx > PLANE_TOLERANCE)
    return { direction: 'X', coordinate: (bar.start[1] + bar.end[1]) / 2 };
  if (dx <= PLANE_TOLERANCE && dy > PLANE_TOLERANCE)
    return { direction: 'Y', coordinate: (bar.start[0] + bar.end[0]) / 2 };
  return null;
}

/** Why a rigid beam cannot be a frame member, or the plane and columns it joins. */
function candidateOf(beam: BeamResult, markOf: (id: string) => string): Candidate | string {
  const bar = beam.loads.bar;
  const plane = planeOf(bar);
  if (!plane) return 'a beam with a rigid joint must lie in a vertical plane parallel to X or Y';
  const columnIds: string[] = [];
  const ends = [
    { name: 'start', joint: bar.startJoint, support: beam.ends[0] },
    { name: 'end', joint: bar.endJoint, support: beam.ends[1] },
  ] as const;
  for (const { name, joint, support } of ends) {
    if (support.type === 'column') {
      columnIds.push(support.id);
      continue;
    }
    if (joint === 'rigid') {
      const where =
        support.type === 'beam' ? `frames into beam ${markOf(support.id)}` : 'bears on nothing';
      return `${name} joint is rigid but the beam ${where}: a moment joint needs a column`;
    }
    if (support.type === 'beam')
      return `${name} end frames into beam ${markOf(support.id)}: the pinned end of a moment-frame beam must bear on a column or be free`;
  }
  return { beam, ...plane, columnIds };
}

/**
 * Frames from the rigid joints of the beams.
 * @invariant a column belongs to at most one frame plane (the first beam in model order wins)
 * @failure rigid joint to nothing / to a beam / beam outside an X or Y plane -> beam rejected with reason
 */
export function detectFrames(
  beams: ReadonlyArray<BeamResult>,
  columns: ReadonlyArray<SteelBar>,
): FrameDetection {
  const columnById = new Map(columns.map((column) => [column.id, column]));
  const markOf = (id: string): string =>
    columnById.get(id)?.mark ?? beams.find((b) => b.loads.bar.id === id)?.loads.bar.mark ?? id;
  const rejected = new Map<string, string>();
  const candidates: Candidate[] = [];
  for (const beam of beams) {
    const bar = beam.loads.bar;
    if (bar.startJoint !== 'rigid' && bar.endJoint !== 'rigid') continue;
    const candidate = candidateOf(beam, markOf);
    if (typeof candidate === 'string') rejected.set(bar.id, candidate);
    else candidates.push(candidate);
  }
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.direction}|${Math.round(candidate.coordinate / PLANE_SNAP)}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const frames: MomentFrame[] = [];
  const claimed = new Map<string, MomentFrame>();
  for (const members of groups.values()) {
    for (const component of connectedComponents(members)) {
      const columnIds = [...new Set(component.flatMap((candidate) => candidate.columnIds))];
      const first = component[0] as Candidate;
      const frameColumns = columnIds.flatMap((id) => columnById.get(id) ?? []);
      const label = frameLabel(first, frameColumns);
      const clash = frameColumns.find((column) => claimed.has(column.id));
      if (clash) {
        const other = claimed.get(clash.id)?.label ?? 'another frame';
        for (const { beam } of component) {
          rejected.set(
            beam.loads.bar.id,
            `column ${clash.mark} already belongs to ${other}: a column is part of one moment-frame plane, this rigid joint is not modelled`,
          );
        }
        continue;
      }
      const frame: MomentFrame = {
        label,
        direction: first.direction,
        coordinate: first.coordinate,
        columns: frameColumns,
        beams: component.map((candidate) => candidate.beam),
      };
      for (const column of frameColumns) claimed.set(column.id, frame);
      frames.push(frame);
    }
  }
  const warnings = [...rejected.entries()].map(([id, reason]) => {
    const bar = beams.find((beam) => beam.loads.bar.id === id)?.loads.bar;
    return `${bar?.mark ?? id}: ${reason}`;
  });
  return { frames, rejected, warnings };
}

/** Candidates joined through shared columns, each component in model order. */
function connectedComponents(candidates: ReadonlyArray<Candidate>): Candidate[][] {
  const components: { columns: Set<string>; members: Candidate[] }[] = [];
  for (const candidate of candidates) {
    const touching = components.filter((component) =>
      candidate.columnIds.some((id) => component.columns.has(id)),
    );
    const merged = {
      columns: new Set([
        ...touching.flatMap((component) => [...component.columns]),
        ...candidate.columnIds,
      ]),
      members: [...touching.flatMap((component) => component.members), candidate],
    };
    merged.members.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
    for (const component of touching) components.splice(components.indexOf(component), 1);
    components.push(merged);
  }
  return components.map((component) => component.members);
}

function frameLabel(first: Candidate, columns: ReadonlyArray<SteelBar>): string {
  const plane = `${first.direction === 'Y' ? 'x' : 'y'} = ${metres(first.coordinate)} m`;
  const marks = columns.map((column) => column.mark);
  const shown =
    marks.length > 3 ? `${marks[0] ?? ''}…${marks[marks.length - 1] ?? ''}` : marks.join(', ');
  return `frame ${plane} (${shown})`;
}
