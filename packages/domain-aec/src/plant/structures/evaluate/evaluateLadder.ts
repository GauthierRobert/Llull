/** Ladder -> merged mesh entities: stiles, rungs, cage hoops, cage bars and landing plates (06 STA M4). */

import type { CadDocument, Entity, MeshData, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { toCounterClockwise } from '@lib/polygon';
import type { BuildingLevel, LadderElement } from '@aec/building/types';
import { meshEntity } from '../../../building/evaluate/entities';
import { atLevel } from '../../../industrial/evaluate';
import { prismMesh, sweepMesh } from '../../../shared/mesh';
import { findProfile, profileOutline } from '../../../steel/profiles';
import { CAGE_BAR_PROFILE, HOOP_PROFILE, LANDING_THICKNESS_MM, RUNG_PROFILE, STILE_PROFILE, type LadderRun } from '../ladder/ladderLayout';
import { ladderQuantities } from '../ladder/ladderMeasure';
import { mergeMeshes } from './meshParts';

const LADDER_COLOR = '#c98a1d';
const CAGE_COLOR = '#b5651d';

export function evaluateLadder(doc: CadDocument, ladder: LadderElement, level: BuildingLevel): Entity[] {
  const factor = fromMm(doc, 1);
  const { layout } = ladderQuantities(doc, ladder);
  const world = (point: Vec3): Vec3 => atLevel(level, point);
  const sweep = (name: string, run: LadderRun, roll: number): MeshData | null => {
    const profile = findProfile(name);
    if (profile === undefined) return null;
    const { outer, holes } = profileOutline(profile);
    return sweepMesh(outer, holes, world(run.from), world(run.to), roll, factor);
  };
  const entities: Entity[] = [];
  const add = (part: string, label: string, mesh: MeshData | null, color: string): void => {
    if (mesh !== null) entities.push(meshEntity(ladder, { part, label: `${label} ${ladder.mark}` }, mesh, color));
  };
  add('stiles', 'Ladder stiles', mergeMeshes(layout.stiles.map((run) => sweep(STILE_PROFILE, run, -ladder.facing))), LADDER_COLOR);
  add('rungs', 'Ladder rungs', mergeMeshes(layout.rungs.map((run) => sweep(RUNG_PROFILE, run, 0))), LADDER_COLOR);
  add('cage-hoops', 'Cage hoops', mergeMeshes(layout.hoops.map((run) => sweep(HOOP_PROFILE, run, 0))), CAGE_COLOR);
  add('cage-bars', 'Cage bars', mergeMeshes(layout.bars.map((run) => sweep(CAGE_BAR_PROFILE, run, 0))), CAGE_COLOR);
  const thickness = LANDING_THICKNESS_MM * factor;
  add(
    'landings',
    'Ladder landings',
    mergeMeshes(
      layout.landings.map((plate) =>
        prismMesh(
          toCounterClockwise(plate.corners),
          [],
          ([x, y], side): Vec3 => [x, y, level.elevation + plate.top - thickness + side * thickness],
        ),
      ),
    ),
    LADDER_COLOR,
  );
  return entities;
}
