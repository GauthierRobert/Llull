/**
 * frameModel: frameModelFrames.
 * @layer core/commands/building
 */

import type { BuildingModel, SteelMemberElement } from '../../../model/building';
import type { CadDocument } from '../../../model/types';
import type { FrameNode } from '../../../../lib/frame2d';
import { fromMm } from '../model';
import { findProfile, sectionProperties } from '../steel/profiles';
import { E_STEEL } from './steelDesign';
import { FLAT_ROOF_LIMIT, frameRoofAverage } from './windCoefficients';
import {
  type AnalysisMember,
  CRANE_FACTORS,
  type CaseLoads,
  DOWNWIND_ROOF_FACTOR,
  type FrameLoads,
  type FrameModel,
  type NodeCaseLoad,
  ROOF_PRESSURE_CASE_MIN_CPE,
  WIND_CASES,
  WIND_COEFFICIENTS,
  WIND_PRESSURE_CASES,
  type WindCase,
  craneActions,
  craneCapacityOf,
  valleyLines,
} from './frameModelTypes';

/**
 * Frames of a level. Planes are grouped per hall (overlapping rafter x-ranges) for tributary
 * widths; a hall with a single frame plane has no tributary width and is reported in `skipped`.
 */
export function framesOf(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
): { frames: FrameModel[]; skipped: string[] } {
  const mm = (value: number): number => value / fromMm(doc, 1);
  const tolerance = 10;
  const members = Object.values(building.elements).filter(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.levelId === levelId,
  );
  const rafters = members.filter(
    (member) =>
      member.role === 'rafter' && Math.abs(mm(member.start[1] - member.end[1])) < tolerance,
  );
  const planeOf = (member: SteelMemberElement): number => Math.round(mm(member.start[1]));
  const xRange = (member: SteelMemberElement): [number, number] => [
    Math.min(mm(member.start[0]), mm(member.end[0])),
    Math.max(mm(member.start[0]), mm(member.end[0])),
  ];
  const near = (a: number, b: number): boolean => Math.abs(a - b) < tolerance;
  // Frame candidates: rafters of one plane chained by touching / overlapping x-ranges.
  interface Candidate {
    readonly y: number;
    range: [number, number];
    readonly rafters: SteelMemberElement[];
  }
  const candidates: Candidate[] = [];
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
  const hallOf = new Map<Candidate, Candidate[]>();
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
  const tributaryOf = (candidate: Candidate): number => {
    const ys = [...new Set((hallOf.get(candidate) ?? [candidate]).map((other) => other.y))].sort(
      (a, b) => a - b,
    );
    const index = ys.indexOf(candidate.y);
    return ((ys[index + 1] ?? candidate.y) - (ys[index - 1] ?? candidate.y)) / 2;
  };
  const gridLabel = (y: number): string => {
    const grid = Object.values(building.elements).find(
      (element) =>
        element.category === 'grid' && near(mm(element.start[1]), y) && near(mm(element.end[1]), y),
    );
    return grid ? `frame ${grid.mark}` : `frame y=${y}`;
  };
  const purlinXs = (y: number): number[] =>
    members
      .filter(
        (member) =>
          member.role === 'purlin' &&
          Math.min(mm(member.start[1]), mm(member.end[1])) <= y + tolerance &&
          Math.max(mm(member.start[1]), mm(member.end[1])) >= y - tolerance,
      )
      .map((member) => mm(member.start[0]));
  const selfWeight = (profileName: string): number =>
    ((findProfile(profileName)?.massPerMetre ?? 0) * 9.81) / 1000;
  const area = (kNPerSquareMetre: number): number => kNPerSquareMetre * 1e-3;
  const skipped: string[] = [];
  const frames = candidates.flatMap((candidate): FrameModel[] => {
    const { y } = candidate;
    const [low, high] = candidate.range;
    const tributary = tributaryOf(candidate);
    if (!(tributary > 0)) {
      skipped.push(`${gridLabel(y)} (single frame: no tributary width)`);
      return [];
    }
    const nodes: FrameNode[] = [];
    const nodeAt = (x: number, z: number, restraint: FrameNode['restraint']): number => {
      const found = nodes.findIndex((node) => near(node.x, x) && near(node.y, z));
      if (found >= 0) return found;
      nodes.push({ x, y: z, restraint });
      return nodes.length - 1;
    };
    const analysis: AnalysisMember[] = [];
    const nodeLoads: NodeCaseLoad[] = [];
    const free: FrameNode['restraint'] = [false, false, false];
    const purlins = purlinXs(y);
    const fixedColumns = new Set(
      Object.values(building.elements).flatMap((element) =>
        element.category === 'plate' && element.fixity === 'fixed' ? [element.memberId] : [],
      ),
    );
    const valleys = valleyLines(
      candidate.rafters.map((rafter) => ({
        start: rafter.start.map(mm),
        end: rafter.end.map(mm),
      })),
    );
    const rafterEnds = (
      rafter: SteelMemberElement,
    ): { x0: number; z0: number; x1: number; z1: number; flip: boolean } => {
      const flip = rafter.start[0] > rafter.end[0];
      const [first, second] = flip ? [rafter.end, rafter.start] : [rafter.start, rafter.end];
      return {
        x0: mm(first[0]),
        z0: mm(first[2]),
        x1: mm(second[0]),
        z1: mm(second[2]),
        flip,
      };
    };
    // A monopitch rafter has no partner meeting it at its high end (no apex).
    const highEnd = (point: readonly number[], other: readonly number[]): boolean =>
      (point[2] ?? 0) >= (other[2] ?? 0);
    const hasApex = (rafter: SteelMemberElement): boolean =>
      candidate.rafters.some((other) => {
        if (other.id === rafter.id) return false;
        const [mine, theirs] = [
          highEnd(rafter.start, rafter.end) ? rafter.start : rafter.end,
          highEnd(other.start, other.end) ? other.start : other.end,
        ];
        return mine.every((value, axis) => near(mm(value), mm(theirs[axis] ?? 0)));
      });
    /**
     * Frame-average roof cpe,10 of a rafter for a wind case (EN 1991-1-4 via windCoefficients.ts):
     * duopitch windward slope H, leeward I/J; monopitch H of the wind direction; flat (< 5°) roofs H on the
     * windward half of the hall and I on the other, weighted by the rafter length in each half. Spans
     * downwind of the windward span (Fig. 7.10, simplified) keep their suction × DOWNWIND_ROOF_FACTOR.
     */
    const roofCpe = (rafter: SteelMemberElement, windCase: WindCase): number => {
      const { x0, z0, x1, z1 } = rafterEnds(rafter);
      const pitchDegrees = (Math.atan2(Math.abs(z1 - z0), Math.abs(x1 - x0)) * 180) / Math.PI;
      const fromLeft = windCase.from === 'left';
      const apex = hasApex(rafter);
      if (pitchDegrees < FLAT_ROOF_LIMIT) {
        const middle = (low + high) / 2;
        const [half0, half1] = fromLeft ? [low, middle] : [middle, high];
        const overlap = Math.max(0, Math.min(x1, half1) - Math.max(x0, half0));
        const share = Math.min(1, overlap / Math.max(x1 - x0, 1));
        const flat = (slope: 'windward' | 'leeward'): number =>
          frameRoofAverage('flat', pitchDegrees, 0, windCase.roofSet, slope);
        return share * flat('windward') + (1 - share) * flat('leeward');
      }
      const faces = fromLeft === z1 > z0;
      if (!apex) {
        return frameRoofAverage('monopitch', pitchDegrees, faces ? 0 : 180, windCase.roofSet);
      }
      const spanIndex = valleys.filter((valley) => valley < (x0 + x1) / 2).length;
      const cpe = frameRoofAverage(
        'duopitch',
        pitchDegrees,
        0,
        windCase.roofSet,
        faces ? 'windward' : 'leeward',
      );
      const windwardSpan = spanIndex === (fromLeft ? 0 : valleys.length);
      return windwardSpan || cpe > 0 ? cpe : DOWNWIND_ROOF_FACTOR * cpe;
    };
    const windCases = [
      ...WIND_CASES,
      ...WIND_PRESSURE_CASES.filter((windCase) =>
        candidate.rafters.some((rafter) => roofCpe(rafter, windCase) >= ROOF_PRESSURE_CASE_MIN_CPE),
      ),
    ];
    for (const rafter of candidate.rafters) {
      const profile = findProfile(rafter.profile);
      if (!profile) continue;
      const section = sectionProperties(profile);
      const { x0, z0, x1, z1, flip } = rafterEnds(rafter);
      const length = Math.hypot(x1 - x0, z1 - z0);
      // Roof loads per horizontal length, spread along the rafter.
      const perLength = (kN: number): number => (area(kN) * tributary * Math.abs(x1 - x0)) / length;
      const stations = [x0, x1, ...purlins.filter((x) => x > x0 && x < x1)].sort((a, b) => a - b);
      const purlinGap = Math.max(
        ...stations.slice(1).map((x, index) => x - (stations[index] as number)),
      );
      analysis.push({
        geometry: {
          a: nodeAt(x0, z0, free),
          b: nodeAt(x1, z1, free),
          E: E_STEEL,
          A: section.area,
          I: section.inertia,
        },
        elementId: rafter.id,
        role: 'rafter',
        reversed: flip,
        ends: [true, true],
        loads: {
          G: { qx: 0, qy: -(perLength(loads.deadLoad) + selfWeight(rafter.profile)) },
          S: { qx: 0, qy: -perLength(loads.snowLoad) },
          ...Object.fromEntries(
            windCases.map((windCase) => [
              windCase.loadCase,
              {
                qx: 0,
                qy: perLength(
                  (windCase.internalPressure - roofCpe(rafter, windCase)) * loads.windPressure,
                ),
              },
            ]),
          ),
        },
        lengths: {
          major: length,
          minor: (purlinGap * length) / Math.max(Math.abs(x1 - x0), 1),
          lateralTorsional: (purlinGap * length) / Math.max(Math.abs(x1 - x0), 1),
        },
      });
    }
    const columnTops: { node: number; height: number; elementId: string }[] = [];
    const craneNodes: { node: number; height: number; elementId: string }[] = [];
    const columns = members.filter(
      (member) =>
        member.role === 'column' &&
        near(mm(member.start[1]), y) &&
        near(mm(member.end[1]), y) &&
        mm(member.start[0]) > low - tolerance &&
        mm(member.start[0]) < high + tolerance,
    );
    const brackets = members.filter(
      (member) =>
        member.role === 'beam' &&
        member.note === 'crane bracket' &&
        near(mm(member.start[1]), y) &&
        near(mm(member.end[1]), y),
    );
    const craneBeams = members.filter((member) => member.role === 'crane');
    // Crane rails of the frame: [column node, bracket height, eccentricity, capacity, runway G].
    const rails: {
      node: number;
      x: number;
      eccentricity: number;
      capacity: number;
      self: number;
    }[] = [];
    for (const column of columns) {
      const profile = findProfile(column.profile);
      if (!profile) continue;
      const [bottom, top] =
        column.start[2] <= column.end[2] ? [column.start, column.end] : [column.end, column.start];
      const [x, zBottom, zTop] = [mm(top[0]), mm(bottom[2]), mm(top[2])];
      const topNode = nodes.findIndex((node) => near(node.x, x) && near(node.y, zTop));
      if (topNode < 0) continue; // gable posts under the rafter span are not analysed
      const section = sectionProperties(profile);
      const height = zTop - zBottom;
      const railLevels = [
        zBottom,
        zTop,
        ...members
          .filter(
            (member) =>
              member.role === 'rail' &&
              Math.abs(mm(member.start[0]) - x) < 1000 &&
              Math.min(mm(member.start[1]), mm(member.end[1])) <= y + tolerance &&
              Math.max(mm(member.start[1]), mm(member.end[1])) >= y - tolerance,
          )
          .map((member) => mm(member.start[2]))
          .filter((z) => z > zBottom && z < zTop),
      ].sort((a, b) => a - b);
      const railGap = Math.max(
        ...railLevels.slice(1).map((z, index) => z - (railLevels[index] as number)),
      );
      const splits: number[] = [];
      for (const bracket of brackets) {
        const z = mm(bracket.start[2]);
        if (!near(mm(bracket.start[0]), x) || !(z > zBottom + tolerance && z < zTop - tolerance))
          continue;
        const [endX, endY] = [mm(bracket.end[0]), mm(bracket.end[1])];
        const runway = craneBeams.filter((beam) =>
          [beam.start, beam.end].some(
            (point) => near(mm(point[0]), endX) && near(mm(point[1]), endY),
          ),
        );
        const capacity =
          loads.craneCapacity ?? Math.max(0, ...runway.map((beam) => craneCapacityOf(beam) ?? 0));
        if (!(capacity > 0)) continue;
        splits.push(z);
        const runwayWeight = runway.reduce(
          (sum, beam) =>
            sum +
            (selfWeight(beam.profile) *
              Math.hypot(mm(beam.end[0] - beam.start[0]), mm(beam.end[1] - beam.start[1]))) /
              2,
          0,
        );
        rails.push({
          node: nodeAt(x, z, free),
          x: endX,
          eccentricity: endX - x,
          capacity,
          self: runwayWeight,
        });
        craneNodes.push({ node: nodeAt(x, z, free), height: z - zBottom, elementId: column.id });
      }
      const chain = [
        nodeAt(x, zBottom, fixedColumns.has(column.id) ? [true, true, true] : [true, true, false]),
        ...[...new Set(splits)].sort((a, b) => a - b).map((z) => nodeAt(x, z, free)),
        topNode,
      ];
      const outer = near(x, low) ? 'left' : near(x, high) ? 'right' : null;
      // Net wall pressure in the wind direction: windward cpe − cpi, leeward |cpe| + cpi (outward).
      const windLoads: CaseLoads =
        outer === null
          ? {}
          : Object.fromEntries(
              windCases.map((windCase) => {
                const coefficient =
                  outer === windCase.from
                    ? WIND_COEFFICIENTS.windward - windCase.internalPressure
                    : WIND_COEFFICIENTS.leeward + windCase.internalPressure;
                const direction = windCase.from === 'left' ? 1 : -1;
                return [
                  windCase.loadCase,
                  {
                    qx: direction * area(coefficient * loads.windPressure) * tributary,
                    qy: 0,
                  },
                ];
              }),
            );
      chain.slice(1).forEach((node, index) => {
        analysis.push({
          geometry: {
            a: chain[index] as number,
            b: node,
            E: E_STEEL,
            A: section.area,
            I: section.inertia,
          },
          elementId: column.id,
          role: 'column',
          reversed: column.start[2] > column.end[2],
          ends: [index === 0, index === chain.length - 2],
          loads: {
            G: { qx: 0, qy: -selfWeight(column.profile) },
            ...windLoads,
          },
          lengths: { major: height, minor: height, lateralTorsional: railGap },
        });
      });
      columnTops.push({ node: topNode, height, elementId: column.id });
    }
    // Crane: rails paired left → right per crane bay; CL = maximum reaction on the left rail.
    const ordered = [...rails].sort((a, b) => a.x - b.x);
    ordered.forEach((rail, index) => {
      const isLeft = index % 2 === 0;
      const partner = ordered[isLeft ? index + 1 : index - 1];
      const actions = craneActions(
        rail.capacity,
        partner ? Math.abs(partner.x - rail.x) : high - low,
        loads.craneModel,
      );
      nodeLoads.push({
        node: rail.node,
        loadCase: 'G',
        fx: 0,
        fy: -rail.self,
        mz: -rail.self * rail.eccentricity,
      });
      // Drive HT acts in the same direction on both rails (CL / CR = +x / −x); skewing HS is a
      // guide reaction balanced by the other rail, hence opposite directions.
      const groups = [
        {
          max: actions.group1.max,
          min: actions.group1.min,
          h: [actions.group1.transverseMax, actions.group1.transverseMin],
          cases: ['CL', 'CR'],
          opposite: false,
        },
        {
          max: actions.group5.max,
          min: actions.group5.min,
          h: [actions.group5.skewMax, actions.group5.skewMin],
          cases: ['CL5', 'CR5'],
          opposite: true,
        },
        {
          max: actions.staticMax,
          min: actions.staticMin,
          h: [
            actions.group1.transverseMax / CRANE_FACTORS.phi5,
            actions.group1.transverseMin / CRANE_FACTORS.phi5,
          ],
          cases: ['CLk', 'CRk'],
          opposite: false,
        },
      ] as const;
      for (const group of groups) {
        for (const loadCase of group.cases) {
          const maximum = !partner || (loadCase === group.cases[0]) === isLeft;
          const reaction = maximum ? group.max : group.min;
          const transverse = maximum ? group.h[0] : group.h[1];
          nodeLoads.push({
            node: rail.node,
            loadCase,
            fx:
              (loadCase === group.cases[0] ? transverse : -transverse) *
              (group.opposite && !maximum ? -1 : 1),
            fy: -reaction,
            mz: -reaction * rail.eccentricity,
          });
        }
      }
    });
    if (analysis.length === 0) return [];
    const topXs = [...new Set(columnTops.map((top) => Math.round(nodes[top.node]?.x ?? 0)))].sort(
      (a, b) => a - b,
    );
    return [
      {
        label:
          candidates.filter((other) => other.y === y).length > 1
            ? `${gridLabel(y)} @x=${low}`
            : gridLabel(y),
        nodes,
        members: analysis,
        windCases,
        nodeLoads,
        columnTops,
        craneNodes,
        spans: topXs.slice(1).map((x, index): [number, number] => [topXs[index] as number, x]),
      },
    ];
  });
  return { frames, skipped };
}
