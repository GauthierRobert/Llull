/** Steel stair -> merged mesh entities: stringers, treads and landings (06 STA M5). */

import type { CadDocument, Entity, MeshData, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { toCounterClockwise } from '@lib/polygon';
import type { BuildingLevel, SteelStairElement } from '@aec/building/types';
import { meshEntity } from '../../../building/evaluate/entities';
import { atLevel } from '../../../industrial/evaluate';
import { prismMesh, sweepMesh } from '../../../shared/mesh';
import { findProfile, profileOutline } from '../../../steel/profiles';
import type { StairPlate } from '../stair/steelStairLayout';
import { stairQuantities, treadThickness } from '../stair/steelStairMeasure';
import { mergeMeshes } from './meshParts';

const STAIR_COLOR = '#b98a2e';
const TREAD_COLOR = '#8f9aa3';

export function evaluateSteelStair(doc: CadDocument, stair: SteelStairElement, level: BuildingLevel): Entity[] {
  const profile = findProfile(stair.stringerProfile);
  if (profile === undefined) return [];
  const { layout } = stairQuantities(doc, stair);
  const factor = fromMm(doc, 1);
  const { outer, holes } = profileOutline(profile);
  const thickness = treadThickness(doc, stair.tread);
  const plateMesh = (plate: StairPlate): MeshData | null =>
    prismMesh(
      toCounterClockwise([...plate.corners]),
      [],
      ([x, y], side): Vec3 => [x, y, level.elevation + plate.top - thickness + side * thickness],
    );
  const entities: Entity[] = [];
  const add = (part: string, label: string, mesh: MeshData | null, color: string): void => {
    if (mesh !== null) entities.push(meshEntity(stair, { part, label: `${label} ${stair.mark}` }, mesh, color));
  };
  add(
    'stringers',
    'Stair stringers',
    mergeMeshes(layout.stringers.map((run) => sweepMesh(outer, holes, atLevel(level, run.from), atLevel(level, run.to), 0, factor))),
    STAIR_COLOR,
  );
  add('treads', 'Stair treads', mergeMeshes(layout.treads.map(plateMesh)), TREAD_COLOR);
  add('landings', 'Stair landings', mergeMeshes(layout.landings.map(plateMesh)), TREAD_COLOR);
  return entities;
}
