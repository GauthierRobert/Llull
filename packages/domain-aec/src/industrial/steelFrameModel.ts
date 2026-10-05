/**
 * 2D model of a moment frame for the direct-stiffness solver: column pieces between the levels
 * where beams join, beams meshed at their point loads, the loads split into permanent / imposed.
 * Units: N, mm; vertical loads positive downward.
 * @layer domain-aec
 * @pure
 */

import type { FrameMember, FrameNode } from '@lib/frame2d';
import { loadTotals } from './steelBeamAnalysis';
import { E_STEEL } from './steelDesign';
import type { MomentFrame } from './steelFrameDetect';
import { inPlaneInertia } from './steelFrameSection';
import type { BeamResult, ColumnNode } from './steelFraming';
import { sectionOf, selfWeightPerMetre, type SteelBar } from './steelMemberBars';

export interface SystemMember {
  readonly geometry: Omit<FrameMember, 'load'>;
  readonly barId: string;
  readonly kind: 'column' | 'beam';
  /** Uniform vertical load per case, N/mm downward. */
  readonly permanent: number;
  readonly imposed: number;
}

export interface SystemLevel {
  readonly z: number;
  /** Column nodes at this level (the horizontal force of the level is shared by them). */
  readonly nodes: number[];
  /** Vertical load carried at the level, N. */
  permanent: number;
  imposed: number;
}

/** Nodes and members of one bar, in order along the bar (columns bottom → top, beams start → end). */
export interface BarLayout {
  readonly kind: 'column' | 'beam';
  readonly nodes: number[];
  readonly members: number[];
  /** Beams: station position of every node along the bar, 0..1. */
  readonly fractions: number[];
  /** Beams: plan coordinate decreases from start to end (members are built left → right). */
  readonly reversed: boolean;
  /** Beams: the end does not join a column (free tip). */
  readonly freeEnds: readonly [boolean, boolean];
}

export interface StoreyPiece {
  readonly columnId: string;
  readonly bottom: number;
  readonly top: number;
  readonly height: number;
  /** Index of the level at the top. */
  readonly storey: number;
}

export interface FrameSystem {
  readonly nodes: FrameNode[];
  readonly members: SystemMember[];
  readonly nodeLoads: { node: number; permanent: number; imposed: number }[];
  readonly levels: SystemLevel[];
  readonly layouts: Map<string, BarLayout>;
  readonly storeyPieces: StoreyPiece[];
  /** Beam id → why it cannot be meshed. */
  readonly invalid: Map<string, string>;
}

const LEVEL_TOLERANCE = 150;
const SNAP_TOLERANCE = 300;
const SAME_POINT = 1;
const MIN_STATIONS = 8;
const MAX_STATIONS = 16;
const STATION_MERGE = 0.002;

const FREE: FrameNode['restraint'] = [false, false, false];

interface ColumnState {
  readonly bar: SteelBar;
  readonly u: number;
  readonly zs: number[];
  readonly nodes: number[];
}

const clusterMeans = (values: ReadonlyArray<number>, tolerance: number): number[] => {
  const groups: number[][] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && value - (last[last.length - 1] as number) <= tolerance) last.push(value);
    else groups.push([value]);
  }
  return groups.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
};

const nearest = (values: ReadonlyArray<number>, target: number): number =>
  values.reduce(
    (best, value, index) =>
      Math.abs(value - target) < Math.abs((values[best] as number) - target) ? index : best,
    0,
  );

/** Beam end z (axis) at the given end. */
const endZ = (beam: BeamResult, end: 0 | 1): number =>
  beam.loads.bar[end === 0 ? 'start' : 'end'][2];

/**
 * Meshes a frame.
 * @param nonFrameReactions reactions delivered to the frame columns by beams that are not frame members
 * @invariant total vertical load of the model = Σ frame beam loads + non-frame reactions + column weights
 */
export function buildFrameSystem(
  frame: MomentFrame,
  nonFrameReactions: ReadonlyMap<string, ReadonlyArray<ColumnNode>>,
): FrameSystem {
  const uOf = (point: readonly number[]): number =>
    (frame.direction === 'Y' ? point[1] : point[0]) as number;
  const nodes: FrameNode[] = [];
  const members: SystemMember[] = [];
  const nodeLoads: FrameSystem['nodeLoads'] = [];
  const layouts = new Map<string, BarLayout>();
  const invalid = new Map<string, string>();
  const addNode = (x: number, y: number, restraint: FrameNode['restraint'] = FREE): number => {
    nodes.push({ x, y, restraint });
    return nodes.length - 1;
  };

  const levelZs = clusterMeans(
    frame.beams.flatMap((beam) =>
      ([0, 1] as const).flatMap((end) =>
        beam.ends[end].type === 'column' ? [endZ(beam, end)] : [],
      ),
    ),
    LEVEL_TOLERANCE,
  );
  const snapZ = (z: number): number => {
    const level = levelZs[nearest(levelZs, z)];
    return level !== undefined && Math.abs(level - z) <= SNAP_TOLERANCE ? level : z;
  };

  const frameBeamIds = new Set(frame.beams.map((beam) => beam.loads.bar.id));
  const states = new Map<string, ColumnState>();
  for (const column of frame.columns) {
    const base = Math.min(column.start[2], column.end[2]);
    const requested: number[] = [];
    for (const beam of frame.beams) {
      for (const end of [0, 1] as const) {
        const support = beam.ends[end];
        if (support.type === 'column' && support.id === column.id)
          requested.push(snapZ(endZ(beam, end)));
      }
    }
    const extras = (nonFrameReactions.get(column.id) ?? [])
      .filter((reaction) => !frameBeamIds.has(reaction.beamId))
      .map((reaction) => snapZ(reaction.zAxis));
    const onLevel = (z: number): boolean => levelZs.includes(z);
    const zs = [
      base,
      ...requested,
      ...extras.filter(onLevel),
      ...clusterMeans(
        extras.filter((z) => !onLevel(z)),
        LEVEL_TOLERANCE,
      ),
    ]
      .sort((a, b) => a - b)
      .filter((z, index, all) => index === 0 || z - (all[index - 1] as number) >= SAME_POINT);
    const u = uOf(column.start);
    const fixed = column.baseFixity === 'fixed';
    const indices = zs.map((z, index) => addNode(u, z, index === 0 ? [true, true, fixed] : FREE));
    states.set(column.id, { bar: column, u, zs, nodes: indices });
  }
  const columnNode = (columnId: string, z: number): number => {
    const state = states.get(columnId);
    if (!state) return -1;
    return state.nodes[nearest(state.zs, z)] as number;
  };

  const levels: SystemLevel[] = levelZs.map((z) => ({
    z,
    nodes: [...states.values()].flatMap((state) =>
      state.zs.flatMap((nodeZ, index) =>
        Math.abs(nodeZ - z) < SAME_POINT ? [state.nodes[index] as number] : [],
      ),
    ),
    permanent: 0,
    imposed: 0,
  }));
  const levelAt = (z: number): SystemLevel | undefined => levels[nearest(levelZs, z)];

  const storeyPieces: StoreyPiece[] = [];
  for (const state of states.values()) {
    const profile = state.bar.profile;
    const section = profile ? sectionOf(profile) : undefined;
    const weight = profile ? selfWeightPerMetre(profile) : 0;
    const memberIds: number[] = [];
    for (let index = 0; index < state.nodes.length - 1; index++) {
      const [bottom, top] = [state.nodes[index] as number, state.nodes[index + 1] as number];
      const height = (state.zs[index + 1] as number) - (state.zs[index] as number);
      memberIds.push(members.length);
      members.push({
        geometry: {
          a: bottom,
          b: top,
          E: E_STEEL,
          A: section?.area ?? 1,
          I: profile ? inPlaneInertia(profile, state.bar.roll, frame.direction) : 1,
        },
        barId: state.bar.id,
        kind: 'column',
        permanent: weight,
        imposed: 0,
      });
      const level = levelAt(state.zs[index + 1] as number);
      if (level) level.permanent += weight * height;
    }
    layouts.set(state.bar.id, {
      kind: 'column',
      nodes: state.nodes,
      members: memberIds,
      fractions: [],
      reversed: false,
      freeEnds: [false, false],
    });
    const boundaries = state.nodes.flatMap((node, index) =>
      index === 0 || levels.some((level) => level.nodes.includes(node)) ? [index] : [],
    );
    boundaries.slice(1).forEach((top, boundary) => {
      const bottom = boundaries[boundary] as number;
      const level = levels.findIndex((candidate) =>
        candidate.nodes.includes(state.nodes[top] as number),
      );
      storeyPieces.push({
        columnId: state.bar.id,
        bottom: state.nodes[bottom] as number,
        top: state.nodes[top] as number,
        height: (state.zs[top] as number) - (state.zs[bottom] as number),
        storey: level,
      });
    });
  }

  for (const [columnId, reactions] of nonFrameReactions) {
    for (const reaction of reactions) {
      if (frameBeamIds.has(reaction.beamId) || !states.has(columnId)) continue;
      const node = columnNode(columnId, snapZ(reaction.zAxis));
      nodeLoads.push({
        node,
        permanent: reaction.permanent * 1000,
        imposed: reaction.imposed * 1000,
      });
      const level = levelAt(reaction.zAxis);
      if (level) {
        level.permanent += reaction.permanent * 1000;
        level.imposed += reaction.imposed * 1000;
      }
    }
  }

  for (const beam of frame.beams) meshBeam(beam);
  return { nodes, members, nodeLoads, levels, layouts, storeyPieces, invalid };

  function meshBeam(beam: BeamResult): void {
    const { bar, lengthM, pieces, points } = beam.loads;
    const profile = bar.profile;
    if (!profile) return;
    const endPoint = (end: 0 | 1): { u: number; z: number; node: number } => {
      const support = beam.ends[end];
      const z = endZ(beam, end);
      if (support.type === 'column') {
        const index = columnNode(support.id, snapZ(z));
        const node = nodes[index] as FrameNode;
        return { u: node.x, z: node.y, node: index };
      }
      const raw = bar[end === 0 ? 'start' : 'end'];
      return { u: uOf(raw), z, node: -1 };
    };
    const [from, to] = [endPoint(0), endPoint(1)];
    if (Math.hypot(to.u - from.u, to.z - from.z) < SAME_POINT) {
      invalid.set(bar.id, 'the beam has no length between the columns it joins');
      return;
    }
    const count = Math.min(MAX_STATIONS, Math.max(MIN_STATIONS, Math.ceil(lengthM / 0.5)));
    const stations = [
      0,
      lengthM,
      ...Array.from({ length: count - 1 }, (_, i) => ((i + 1) * lengthM) / count),
      ...points.map((point) => Math.min(lengthM, Math.max(0, point.at))),
    ]
      .sort((a, b) => a - b)
      .filter((s, index, all) => index === 0 || s - (all[index - 1] as number) > STATION_MERGE);
    stations[stations.length - 1] = lengthM;
    const indices = stations.map((s, index) => {
      if (index === 0 && from.node >= 0) return from.node;
      if (index === stations.length - 1 && to.node >= 0) return to.node;
      const t = s / lengthM;
      return addNode(from.u + t * (to.u - from.u), from.z + t * (to.z - from.z));
    });
    const reversed = to.u < from.u;
    const section = sectionOf(profile);
    const memberIds: number[] = [];
    const releaseStart = beam.ends[0].type === 'column' && bar.startJoint !== 'rigid';
    const releaseEnd = beam.ends[1].type === 'column' && bar.endJoint !== 'rigid';
    for (let index = 0; index < stations.length - 1; index++) {
      const [s0, s1] = [stations[index] as number, stations[index + 1] as number];
      const overlap = (piece: { from: number; to: number }): number =>
        Math.max(0, Math.min(s1, piece.to) - Math.max(s0, piece.from));
      const average = (key: 'permanent' | 'imposed'): number =>
        pieces.reduce((sum, piece) => sum + piece[key] * overlap(piece), 0) / (s1 - s0);
      const [lowNode, highNode] = [indices[index] as number, indices[index + 1] as number];
      const [releaseLow, releaseHigh] = [
        index === 0 && releaseStart,
        index === stations.length - 2 && releaseEnd,
      ];
      memberIds.push(members.length);
      members.push({
        geometry: {
          a: reversed ? highNode : lowNode,
          b: reversed ? lowNode : highNode,
          E: E_STEEL,
          A: section.area,
          I: section.inertia,
          releaseA: reversed ? releaseHigh : releaseLow,
          releaseB: reversed ? releaseLow : releaseHigh,
        },
        barId: bar.id,
        kind: 'beam',
        permanent: average('permanent'),
        imposed: average('imposed'),
      });
    }
    for (const point of points) {
      const station = nearest(stations, Math.min(lengthM, Math.max(0, point.at)));
      nodeLoads.push({
        node: indices[station] as number,
        permanent: point.permanent * 1000,
        imposed: point.imposed * 1000,
      });
    }
    const totals = loadTotals(pieces, points);
    const level = levelAt((from.z + to.z) / 2);
    if (level) {
      level.permanent += totals.permanent * 1000;
      level.imposed += totals.imposed * 1000;
    }
    layouts.set(bar.id, {
      kind: 'beam',
      nodes: indices,
      members: memberIds,
      fractions: stations.map((s) => s / lengthM),
      reversed,
      freeEnds: [beam.ends[0].type !== 'column', beam.ends[1].type !== 'column'],
    });
  }
}
