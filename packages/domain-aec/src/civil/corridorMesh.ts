/**
 * Road corridor geometry: carriageway + shoulder mesh along the design profile, side-slope batters
 * to daylight on the existing ground, and the daylight lines.
 * @layer domain-aec/civil
 * @pure
 */

import type { Entity, Vec2 } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { civilMesh, civilPolyline } from './entities';
import { sampleStations } from './alignmentGeometry';
import { designElevation, validateProfile, verticalCurveStations } from './profileGeometry';
import { crossSectionAt, type RoadCrossSection, type SectionNode } from './roadSection';
import { surfaceTinById } from './surfaceTin';
import type { CivilContext } from './context';
import { toMetres } from '../model';

interface MeshBuffers {
  readonly positions: number[];
  readonly indices: number[];
}

function vertex(cross: RoadCrossSection, node: SectionNode): [number, number, number] {
  return [
    cross.origin[0] - Math.sin(cross.direction) * node.offset,
    cross.origin[1] + Math.cos(cross.direction) * node.offset,
    node.z,
  ];
}

/** Adds a strip between consecutive rows of nodes (ascending offset), facing up. */
function addStrip(
  buffers: MeshBuffers,
  rows: ReadonlyArray<{ cross: RoadCrossSection; nodes: ReadonlyArray<SectionNode> }>,
): void {
  const base = buffers.positions.length / 3;
  const width = rows[0]?.nodes.length ?? 0;
  for (const row of rows) {
    for (const node of row.nodes) buffers.positions.push(...vertex(row.cross, node));
  }
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let j = 0; j + 1 < width; j++) {
      const a = base + r * width + j;
      const b = base + (r + 1) * width + j;
      buffers.indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
}

function daylightRuns(
  sections: ReadonlyArray<RoadCrossSection>,
  pick: (cross: RoadCrossSection) => SectionNode | null,
): Array<Array<{ cross: RoadCrossSection; node: SectionNode }>> {
  const runs: Array<Array<{ cross: RoadCrossSection; node: SectionNode }>> = [];
  let current: Array<{ cross: RoadCrossSection; node: SectionNode }> = [];
  for (const cross of sections) {
    const node = pick(cross);
    if (node) current.push({ cross, node });
    else {
      if (current.length > 0) runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Corridor mesh, batter meshes and daylight lines; [] without a valid profile and road section. */
export function evaluateCorridor(context: CivilContext, alignment: AlignmentObject): Entity[] {
  const { section, profile } = alignment;
  if (!section || validateProfile(profile) !== null) return [];
  const tin = alignment.surfaceId ? surfaceTinById(context.civil, alignment.surfaceId) : null;
  const unitsPerMetre = 1 / toMetres(context.doc, 1);
  const sections: RoadCrossSection[] = [];
  for (const station of sampleStations(
    alignment,
    alignment.stationInterval,
    verticalCurveStations(profile),
  )) {
    const designZ = designElevation(profile, station);
    if (designZ === null) continue;
    const cross = crossSectionAt(alignment, section, tin, station, designZ, unitsPerMetre);
    if (cross) sections.push(cross);
  }
  if (sections.length < 2) return [];
  const road: MeshBuffers = { positions: [], indices: [] };
  addStrip(
    road,
    sections.map((cross) => ({ cross, nodes: cross.template })),
  );
  const entities: Entity[] = [
    civilMesh(alignment, 'corridor', `${alignment.name} carriageway`, 'corridor', road),
  ];
  const batters: MeshBuffers = { positions: [], indices: [] };
  const sides: Array<{
    part: string;
    pick: (c: RoadCrossSection) => SectionNode | null;
    edge: (c: RoadCrossSection) => SectionNode;
    edgeFirst: boolean;
  }> = [
    {
      part: 'left',
      pick: (c) => c.left,
      edge: (c) => c.template[c.template.length - 1] as SectionNode,
      edgeFirst: true,
    },
    {
      part: 'right',
      pick: (c) => c.right,
      edge: (c) => c.template[0] as SectionNode,
      edgeFirst: false,
    },
  ];
  for (const side of sides) {
    for (const run of daylightRuns(sections, side.pick)) {
      addStrip(
        batters,
        run.map(({ cross, node }) => ({
          cross,
          nodes: side.edgeFirst ? [side.edge(cross), node] : [node, side.edge(cross)],
        })),
      );
    }
  }
  if (batters.indices.length > 0) {
    entities.push(
      civilMesh(alignment, 'batters', `${alignment.name} side slopes`, 'daylight', batters),
    );
  }
  let lineIndex = 0;
  for (const side of sides) {
    for (const run of daylightRuns(sections, side.pick)) {
      if (run.length < 2) continue;
      const points = run.map(({ cross, node }): Vec2 => {
        const [x, y] = vertex(cross, node);
        return [x, y];
      });
      const meanZ = run.reduce((sum, { node }) => sum + node.z, 0) / run.length;
      entities.push(
        civilPolyline(
          alignment,
          `daylight${lineIndex++}`,
          `${alignment.name} daylight ${side.part}`,
          'daylight',
          points,
          false,
          meanZ,
        ),
      );
    }
  }
  return entities;
}
