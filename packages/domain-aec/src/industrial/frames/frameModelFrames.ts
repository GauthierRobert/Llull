import type { BuildingModel, SteelMemberElement } from '@aec/building/types';
import type { CadDocument } from '@core/model/types';
import type { FrameNode } from '@lib/frame2d';
import { toMm } from '@core/model/units';
import { elementsOf, levelElementsOf } from '../../building/model';
import { weightKnPerMetre } from '../../shared/numeric';
import { findProfile, sectionProperties } from '../../steel/profiles';
import { E_STEEL } from '../steelDesign/steelDesign';
import { haunchEndsOf, rafterPieces } from './haunchSection';

import { type CraneRail, craneRailLoads, frameCandidates, frameRoofWind } from './frameLoads';
import {
  type AnalysisMember,
  type CaseLoads,
  type FrameLoads,
  type FrameModel,
  type NodeCaseLoad,
  ROOF_PRESSURE_CASE_MIN_CPE,
  WIND_CASES,
  WIND_COEFFICIENTS,
  WIND_PRESSURE_CASES,
  craneCapacityOf,
  valleyLines,
} from './frameModelTypes';

/**
 * Frames of a level. Planes are grouped per hall (overlapping rafter x-ranges) for tributary widths; a hall with a single frame plane has
 * no tributary width and is reported in `skipped`.
 */
export function framesOf(
  doc: Pick<CadDocument, 'units'>,
  building: BuildingModel,
  levelId: string,
  loads: FrameLoads,
): { frames: FrameModel[]; skipped: string[] } {
  const mm = (value: number): number => toMm(doc, value);
  const tolerance = 10;
  const members = levelElementsOf(building, 'member', levelId);
  const rafters = members.filter((member) => member.role === 'rafter' && Math.abs(mm(member.start[1] - member.end[1])) < tolerance);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < tolerance;
  const spansY = (member: SteelMemberElement, y: number): boolean =>
    Math.min(mm(member.start[1]), mm(member.end[1])) <= y + tolerance && Math.max(mm(member.start[1]), mm(member.end[1])) >= y - tolerance;
  const { candidates, tributaryOf } = frameCandidates(rafters, mm, tolerance);
  const gridLabel = (y: number): string => {
    const grid = Object.values(building.elements).find(
      (element) => element.category === 'grid' && near(mm(element.start[1]), y) && near(mm(element.end[1]), y),
    );
    return grid ? `frame ${grid.mark}` : `frame y=${y}`;
  };
  const purlinXs = (y: number): number[] =>
    members.filter((member) => member.role === 'purlin' && spansY(member, y)).map((member) => mm(member.start[0]));
  const selfWeight = (profileName: string): number => weightKnPerMetre(findProfile(profileName)?.massPerMetre ?? 0);
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
    const fixedColumns = new Set(elementsOf(building, 'plate').flatMap((plate) => (plate.fixity === 'fixed' ? [plate.memberId] : [])));
    const valleys = valleyLines(candidate.rafters.map((rafter) => ({ start: rafter.start.map(mm), end: rafter.end.map(mm) })));
    const { rafterEnds, roofCpe } = frameRoofWind({ low, high, rafters: candidate.rafters, valleys }, mm, near);
    const windCases = [
      ...WIND_CASES,
      ...WIND_PRESSURE_CASES.filter((windCase) =>
        candidate.rafters.some((rafter) => roofCpe(rafter, windCase) >= ROOF_PRESSURE_CASE_MIN_CPE),
      ),
    ];
    for (const rafter of candidate.rafters) {
      const profile = findProfile(rafter.profile);
      if (!profile) continue;
      const { x0, z0, x1, z1, flip } = rafterEnds(rafter);
      const length = Math.hypot(x1 - x0, z1 - z0);
      // Roof loads per horizontal length, spread along the rafter.
      const perLength = (kN: number): number => (area(kN) * tributary * Math.abs(x1 - x0)) / length;
      const stations = [x0, x1, ...purlins.filter((x) => x > x0 && x < x1)].sort((a, b) => a - b);
      const purlinGap = Math.max(...stations.slice(1).map((x, index) => x - (stations[index] as number)));
      const unbraced = (purlinGap * length) / Math.max(Math.abs(x1 - x0), 1);
      const loadsOf = (haunchWeight: number): CaseLoads => ({
        G: { qx: 0, qy: -(perLength(loads.deadLoad) + selfWeight(rafter.profile) * (1 + haunchWeight)) },
        S: { qx: 0, qy: -perLength(loads.snowLoad) },
        ...Object.fromEntries(
          windCases.map((windCase) => [
            windCase.loadCase,
            { qx: 0, qy: perLength((windCase.internalPressure - roofCpe(rafter, windCase)) * loads.windPressure) },
          ]),
        ),
      });
      // Haunched ends (eaves / apex connections) are stepped pieces with the inertia of the built-up section; analysis runs left → right.
      const [startEnd, finishEnd] = haunchEndsOf(building, rafter, mm, (columnId) => {
        const column = building.elements[columnId];
        return column?.category === 'member' ? (findProfile(column.profile)?.h ?? 0) : 0;
      });
      const pieces = rafterPieces(profile, length, flip ? [finishEnd, startEnd] : [startEnd, finishEnd]);
      const pointAt = (s: number): [number, number] => [x0 + ((x1 - x0) * s) / length, z0 + ((z1 - z0) * s) / length];
      pieces.forEach((piece, index) => {
        const section = sectionProperties(piece.stiffness);
        const [from, to] = [pointAt(piece.from), pointAt(piece.to)];
        analysis.push({
          geometry: { a: nodeAt(from[0], from[1], free), b: nodeAt(to[0], to[1], free), E: E_STEEL, A: section.area, I: section.inertia },
          elementId: rafter.id,
          role: 'rafter',
          reversed: flip,
          ends: [index === 0, index === pieces.length - 1],
          loads: loadsOf(0.5 * ((piece.stiffness.h - profile.h) / profile.h)),
          lengths: { major: length, minor: unbraced, lateralTorsional: unbraced },
          ...(piece.resistance ? { section: piece.resistance } : {}),
        });
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
      (member) => member.role === 'beam' && member.note === 'crane bracket' && near(mm(member.start[1]), y) && near(mm(member.end[1]), y),
    );
    const craneBeams = members.filter((member) => member.role === 'crane');
    // Crane rails of the frame: [column node, bracket height, eccentricity, capacity, runway G].
    const rails: CraneRail[] = [];
    for (const column of columns) {
      const profile = findProfile(column.profile);
      if (!profile) continue;
      const [bottom, top] = column.start[2] <= column.end[2] ? [column.start, column.end] : [column.end, column.start];
      const [x, zBottom, zTop] = [mm(top[0]), mm(bottom[2]), mm(top[2])];
      const topNode = nodes.findIndex((node) => near(node.x, x) && near(node.y, zTop));
      if (topNode < 0) continue; // gable posts under the rafter span are not analysed
      const section = sectionProperties(profile);
      const height = zTop - zBottom;
      const railLevels = [
        zBottom,
        zTop,
        ...members
          .filter((member) => member.role === 'rail' && Math.abs(mm(member.start[0]) - x) < 1000 && spansY(member, y))
          .map((member) => mm(member.start[2]))
          .filter((z) => z > zBottom && z < zTop),
      ].sort((a, b) => a - b);
      const railGap = Math.max(...railLevels.slice(1).map((z, index) => z - (railLevels[index] as number)));
      const splits: number[] = [];
      for (const bracket of brackets) {
        const z = mm(bracket.start[2]);
        if (!near(mm(bracket.start[0]), x) || !(z > zBottom + tolerance && z < zTop - tolerance)) continue;
        const [endX, endY] = [mm(bracket.end[0]), mm(bracket.end[1])];
        const runway = craneBeams.filter((beam) =>
          [beam.start, beam.end].some((point) => near(mm(point[0]), endX) && near(mm(point[1]), endY)),
        );
        const capacity = loads.craneCapacity ?? Math.max(0, ...runway.map((beam) => craneCapacityOf(beam) ?? 0));
        if (!(capacity > 0)) continue;
        splits.push(z);
        const runwayWeight = runway.reduce(
          (sum, beam) =>
            sum + (selfWeight(beam.profile) * Math.hypot(mm(beam.end[0] - beam.start[0]), mm(beam.end[1] - beam.start[1]))) / 2,
          0,
        );
        rails.push({ node: nodeAt(x, z, free), x: endX, eccentricity: endX - x, capacity, self: runwayWeight });
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
                return [windCase.loadCase, { qx: direction * area(coefficient * loads.windPressure) * tributary, qy: 0 }];
              }),
            );
      chain.slice(1).forEach((node, index) => {
        analysis.push({
          geometry: { a: chain[index] as number, b: node, E: E_STEEL, A: section.area, I: section.inertia },
          elementId: column.id,
          role: 'column',
          reversed: column.start[2] > column.end[2],
          ends: [index === 0, index === chain.length - 2],
          loads: { G: { qx: 0, qy: -selfWeight(column.profile) }, ...windLoads },
          lengths: { major: height, minor: height, lateralTorsional: railGap },
        });
      });
      columnTops.push({ node: topNode, height, elementId: column.id });
    }
    nodeLoads.push(...craneRailLoads(rails, loads.craneModel, high - low));
    if (analysis.length === 0) return [];
    const topXs = [...new Set(columnTops.map((top) => Math.round(nodes[top.node]?.x ?? 0)))].sort((a, b) => a - b);
    return [
      {
        label: candidates.filter((other) => other.y === y).length > 1 ? `${gridLabel(y)} @x=${low}` : gridLabel(y),
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
