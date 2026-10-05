/**
 * Pipe weight through explicit supports: each attached support carries the pipe weight over half
 * the span to its neighbours (the full overhang to a free end, half the span to an end carried by an
 * equipment nozzle or a header) as a point load on its member — on a floor beam at the support
 * (shoe on the top flange, hanger at the rod attachment) or axially on a column.
 * @layer domain-aec
 * @pure
 */

import type { ModelUnits, SteelBar } from './steelMemberBars';
import type { ColumnNode } from './steelFraming';
import { addPointLoad, type BeamLoads } from './steelBeamLoads';
import {
  endCarriers,
  pipeRunsOf,
  supportsOfPipe,
  supportStations,
  isLateralOnly,
  SAME_SUPPORT_DISTANCE,
  type PipeRun,
  type SupportStation,
} from './pipeSupportLayout';

/** A support whose pipe underside is within this of the column top sits on it (concentric), mm. */
const COLUMN_TOP_TOLERANCE = 25;

export interface SupportedPipeLoad {
  /** Weight delivered to steel members, kN. */
  readonly carriedKn: number;
  /** Attached supports used. */
  readonly supports: number;
  readonly warnings: string[];
  /** Column-borne loads: column id → nodes for the column check. */
  readonly columnNodes: Array<readonly [string, ColumnNode]>;
}

/** Tributary length (mm) of each station of `stations`, grouping stations closer than SAME_SUPPORT_DISTANCE. */
export function tributaryLengths(
  arcs: ReadonlyArray<number>,
  length: number,
  carriedStart: boolean,
  carriedEnd: boolean,
): number[] {
  const groups: number[][] = [];
  arcs.forEach((arc, index) => {
    const last = groups.at(-1);
    if (last && arc - (arcs[last.at(-1) as number] as number) < SAME_SUPPORT_DISTANCE) {
      last.push(index);
    } else groups.push([index]);
  });
  const centres = groups.map(
    (group) => group.reduce((sum, index) => sum + (arcs[index] as number), 0) / group.length,
  );
  const result = new Array<number>(arcs.length).fill(0);
  groups.forEach((group, position) => {
    const here = centres[position] as number;
    const previous = centres[position - 1];
    const next = centres[position + 1];
    const before = previous !== undefined ? (here - previous) / 2 : carriedStart ? here / 2 : here;
    const after =
      next !== undefined ? (next - here) / 2 : carriedEnd ? (length - here) / 2 : length - here;
    for (const index of group) result[index] = (before + after) / group.length;
  });
  return result;
}

/** Collects the support loads of one pipe; mutates the `beams` it loads. */
export function applySupportedPipe(
  units: ModelUnits,
  run: PipeRun,
  weightPerMetre: number,
  beams: ReadonlyArray<BeamLoads>,
  bars: ReadonlyArray<SteelBar>,
): SupportedPipeLoad {
  const { building } = units;
  const label = `pipe ${run.element.mark}${run.element.line !== undefined ? ` (${run.element.line})` : ''}`;
  const warnings: string[] = [];
  const columnNodes: Array<readonly [string, ColumnNode]> = [];
  const stations = supportStations(units, run, supportsOfPipe(units, run.element.id));
  const attached = stations.filter((station) => station.attached && !isLateralOnly(station));
  for (const station of stations.filter((candidate) => !candidate.attached)) {
    warnings.push(
      `support ${station.mark} (${station.type} on ${label}) is attached to no steel member: it carries nothing`,
    );
  }
  if (attached.length === 0) {
    warnings.push(
      `${label}: none of its supports bears on steel, so its ${((weightPerMetre * run.lengthMm) / 1e6).toFixed(1)} kN are not carried by any checked member`,
    );
  }
  const [startCarrier, endCarrier] = endCarriers(units, run, pipeRunsOf(units));
  const tributaries = tributaryLengths(
    attached.map((station) => station.arc),
    run.lengthMm,
    startCarrier !== null,
    endCarrier !== null,
  );
  let carried = 0;
  attached.forEach((station: SupportStation, index) => {
    const weight = (weightPerMetre * (tributaries[index] as number)) / 1000;
    const member = building.elements[station.memberId ?? ''];
    const bar = bars.find((candidate) => candidate.id === station.memberId);
    const beam = beams.find((candidate) => candidate.bar.id === station.memberId);
    if (beam) {
      const [dx, dy] = [beam.b[0] - beam.a[0], beam.b[1] - beam.a[1]];
      const squared = dx * dx + dy * dy || 1;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((station.point[0] - beam.a[0]) * dx + (station.point[1] - beam.a[1]) * dy) / squared,
        ),
      );
      addPointLoad(beam, t * beam.lengthM * 1000, weight, 0, true);
      if (station.type !== 'hanger') beam.lineSupport = true;
      carried += weight;
    } else if (bar?.kind === 'column') {
      columnNodes.push([
        bar.id,
        {
          beamId: station.id,
          zAxis: Math.min(bar.end[2], Math.max(bar.start[2], station.point[2])),
          permanent: weight,
          imposed: 0,
        },
      ]);
      const top = Math.max(bar.start[2], bar.end[2]);
      if (station.point[2] - run.diameterMm / 2 < top - COLUMN_TOP_TOLERANCE) {
        warnings.push(
          `support ${station.mark} (${station.type} on ${label}) is bracketed off column ${bar.mark}: its ${weight.toFixed(1)} kN are taken as axial load; the bracket eccentricity is not checked`,
        );
      }
      carried += weight;
    } else {
      const role =
        member?.category === 'member' ? `${member.role} ${member.mark}` : station.memberId;
      warnings.push(
        `support ${station.mark} (${station.type} on ${label}) bears on ${role ?? 'nothing'}, which check_steel_members does not analyse as a floor beam or column: its ${weight.toFixed(1)} kN are not carried by any checked member`,
      );
    }
  });
  return { carriedKn: carried, supports: attached.length, warnings, columnNodes };
}
