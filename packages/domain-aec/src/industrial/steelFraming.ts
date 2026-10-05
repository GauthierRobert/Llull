/**
 * Floor framing load path: each beam is simply supported between its end nodes; its end reactions
 * go to the column at the node, or as a point load to the beam it frames into (secondary on
 * primary). Beams are analysed supporters-last, so every transferred reaction is in place.
 * @layer domain-aec
 * @pure
 */

import { projectOntoSegment } from '@lib/polygon';
import { analyseSimpleBeam, type BeamResponse } from './steelBeamAnalysis';
import { addPointLoad, flushBins, type BeamLoads } from './steelBeamLoads';
import { E_STEEL } from './steelDesign';
import { sectionOf, type SteelBar } from './steelMemberBars';

export const GAMMA_PERMANENT = 1.35;
export const GAMMA_IMPOSED = 1.5;

type SupportRef =
  | { readonly type: 'column'; readonly id: string }
  | { readonly type: 'beam'; readonly id: string; readonly at: number }
  | { readonly type: 'none' };

export interface BeamResult {
  readonly loads: BeamLoads;
  /** 1.35 G + 1.5 Q. */
  readonly uls: BeamResponse;
  /** G + Q with deflection. */
  readonly sls: BeamResponse;
  readonly ends: readonly [SupportRef, SupportRef];
}

/** Characteristic reaction of one beam end delivered to a column. */
export interface ColumnNode {
  readonly beamId: string;
  /** Axis height of the beam end, mm. */
  readonly zAxis: number;
  readonly permanent: number;
  readonly imposed: number;
}

export interface FramingResult {
  readonly results: Map<string, BeamResult>;
  readonly columnNodes: Map<string, ColumnNode[]>;
  readonly warnings: string[];
}

const COLUMN_MARGIN = 75;
const BEAM_END_CLEARANCE = 100;
const BEAM_TOP_TOLERANCE = 20;

function columnAt(
  point: readonly [number, number],
  z: number,
  columns: ReadonlyArray<SteelBar>,
): SteelBar | undefined {
  let best: { column: SteelBar; distance: number } | undefined;
  for (const column of columns) {
    const half = Math.max(column.profile?.h ?? 0, column.profile?.b ?? 0) / 2 + COLUMN_MARGIN;
    const distance = Math.hypot(column.start[0] - point[0], column.start[1] - point[1]);
    const low = Math.min(column.start[2], column.end[2]) - 150;
    const high = Math.max(column.start[2], column.end[2]) + 150;
    if (distance <= half && z >= low && z <= high && (!best || distance < best.distance)) {
      best = { column, distance };
    }
  }
  return best?.column;
}

function beamAt(
  point: readonly [number, number],
  carried: BeamLoads,
  beams: ReadonlyArray<BeamLoads>,
): SupportRef {
  let best: { ref: SupportRef; distance: number } | undefined;
  const direction = (beam: BeamLoads): [number, number] => {
    const length = Math.hypot(beam.b[0] - beam.a[0], beam.b[1] - beam.a[1]) || 1;
    return [(beam.b[0] - beam.a[0]) / length, (beam.b[1] - beam.a[1]) / length];
  };
  const [cx, cy] = direction(carried);
  for (const beam of beams) {
    if (beam === carried) continue;
    const [bx, by] = direction(beam);
    if (Math.abs(cx * by - cy * bx) < 0.1) continue;
    const depth = beam.bar.profile?.h ?? 0;
    if (
      carried.top > beam.top + BEAM_TOP_TOLERANCE ||
      carried.top < beam.top - depth - BEAM_TOP_TOLERANCE
    ) {
      continue;
    }
    const { distance, t } = projectOntoSegment(point, beam.a, beam.b);
    const along = t * beam.lengthM * 1000;
    const flange = (beam.bar.profile?.b ?? 0) / 2 + 50;
    if (distance > flange) continue;
    if (along < BEAM_END_CLEARANCE || along > beam.lengthM * 1000 - BEAM_END_CLEARANCE) continue;
    if (!best || distance < best.distance) {
      best = { ref: { type: 'beam', id: beam.bar.id, at: along }, distance };
    }
  }
  return best?.ref ?? { type: 'none' };
}

/** Supporters come after the beams they carry; members of a cycle follow in model order. */
function analysisOrder(
  beams: ReadonlyArray<BeamLoads>,
  ends: ReadonlyMap<string, readonly [SupportRef, SupportRef]>,
): { order: BeamLoads[]; cyclic: BeamLoads[] } {
  const byId = new Map(beams.map((beam) => [beam.bar.id, beam]));
  const pending = new Map<string, number>(beams.map((beam) => [beam.bar.id, 0]));
  for (const beam of beams) {
    for (const end of ends.get(beam.bar.id) ?? []) {
      if (end.type === 'beam') pending.set(end.id, (pending.get(end.id) ?? 0) + 1);
    }
  }
  const order: BeamLoads[] = [];
  const queue = beams.filter((beam) => pending.get(beam.bar.id) === 0);
  const done = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const beam = queue[index] as BeamLoads;
    order.push(beam);
    done.add(beam.bar.id);
    for (const end of ends.get(beam.bar.id) ?? []) {
      if (end.type !== 'beam') continue;
      const remaining = (pending.get(end.id) ?? 1) - 1;
      pending.set(end.id, remaining);
      const target = byId.get(end.id);
      if (remaining === 0 && target) queue.push(target);
    }
  }
  const cyclic = beams.filter((beam) => !done.has(beam.bar.id));
  return { order: [...order, ...cyclic], cyclic };
}

/**
 * Analyse every beam and route its reactions.
 * @invariant a reaction is delivered to exactly one support per beam end (column, beam, or lost)
 * @failure end supported by nothing -> reaction lost, warning
 */
export function analyseFraming(
  beams: ReadonlyArray<BeamLoads>,
  columns: ReadonlyArray<SteelBar>,
): FramingResult {
  const warnings: string[] = [];
  const ends = new Map<string, readonly [SupportRef, SupportRef]>();
  for (const beam of beams) {
    const resolve = (point: readonly [number, number], z: number): SupportRef => {
      const column = columnAt(point, z, columns);
      return column ? { type: 'column', id: column.id } : beamAt(point, beam, beams);
    };
    ends.set(beam.bar.id, [resolve(beam.a, beam.bar.start[2]), resolve(beam.b, beam.bar.end[2])]);
    flushBins(beam);
  }
  const { order, cyclic } = analysisOrder(beams, ends);
  if (cyclic.length > 0) {
    warnings.push(
      `circular beam framing at ${cyclic.map((beam) => beam.bar.mark).join(', ')}: reactions transferred in model order`,
    );
  }
  const results = new Map<string, BeamResult>();
  const columnNodes = new Map<string, ColumnNode[]>();
  const loaded = new Map(beams.map((beam) => [beam.bar.id, beam]));
  for (const beam of order) {
    const profile = beam.bar.profile;
    const rigidity = profile ? (E_STEEL * sectionOf(profile).inertia) / 1e9 : 0;
    const analyse = (permanent: number, imposed: number, stiffness = 0): BeamResponse =>
      analyseSimpleBeam(beam.lengthM, beam.pieces, beam.points, { permanent, imposed }, stiffness);
    const permanent = analyse(1, 0);
    const imposed = analyse(0, 1);
    const pair = ends.get(beam.bar.id) ?? [{ type: 'none' }, { type: 'none' }];
    results.set(beam.bar.id, {
      loads: beam,
      uls: analyse(GAMMA_PERMANENT, GAMMA_IMPOSED),
      sls: analyse(1, 1, rigidity),
      ends: pair as readonly [SupportRef, SupportRef],
    });
    const reactions = [
      [permanent.reactionStart, imposed.reactionStart, beam.bar.start[2]],
      [permanent.reactionEnd, imposed.reactionEnd, beam.bar.end[2]],
    ] as const;
    pair.forEach((support, index) => {
      const [gReaction, qReaction, z] = reactions[index] as readonly [number, number, number];
      if (support.type === 'column') {
        const nodes = columnNodes.get(support.id) ?? [];
        nodes.push({ beamId: beam.bar.id, zAxis: z, permanent: gReaction, imposed: qReaction });
        columnNodes.set(support.id, nodes);
      } else if (support.type === 'beam') {
        const target = loaded.get(support.id);
        if (target) addPointLoad(target, support.at, gReaction, qReaction, false);
      } else {
        warnings.push(
          `${beam.bar.mark} ${index === 0 ? 'start' : 'end'} rests on no column or beam: its ${(gReaction + qReaction).toFixed(1)} kN reaction is not carried`,
        );
      }
    });
  }
  return { results, columnNodes, warnings };
}
