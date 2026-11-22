/** Winder / spiral stair -> merged mesh entities: treads and sections (06 STA §13.15). */

import type { CadDocument, Entity, MeshData, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { toCounterClockwise } from '@lib/polygon';
import type { BuildingLevel, RadialStairElement } from '@aec/building/types';
import { meshEntity } from '../../../building/evaluate/entities';
import { atLevel } from '../../../industrial/evaluate';
import { prismMesh, sweepMesh } from '../../../shared/mesh';
import { findProfile, profileOutline } from '../../../steel/profiles';
import { treadThickness } from '../stair/steelStairMeasure';
import { mergeMeshes } from './meshParts';

export function evaluateRadialStair(doc: CadDocument, stair: RadialStairElement, level: BuildingLevel): Entity[] {
  const profile = findProfile(stair.profile);
  if (profile === undefined) return [];
  const { outer, holes } = profileOutline(profile);
  const thickness = treadThickness(doc, stair.tread);
  const treads = stair.plates.map((plate): MeshData | null =>
    prismMesh(
      toCounterClockwise([...plate.corners]),
      [],
      ([x, y], side): Vec3 => [x, y, level.elevation + plate.top - thickness + side * thickness],
    ),
  );
  const sections = stair.runs.map((run) => sweepMesh(outer, holes, atLevel(level, run.from), atLevel(level, run.to), 0, fromMm(doc, 1)));
  const entities: Entity[] = [];
  const add = (part: string, label: string, mesh: MeshData | null, color: string): void => {
    if (mesh !== null) entities.push(meshEntity(stair, { part, label: `${label} ${stair.mark}` }, mesh, color));
  };
  add('sections', stair.form === 'spiral' ? 'Spiral stair column' : 'Winder stair stringers', mergeMeshes(sections), '#b98a2e');
  add('treads', stair.form === 'spiral' ? 'Spiral stair treads' : 'Winder stair treads', mergeMeshes(treads), '#8f9aa3');
  return entities;
}
