/** Railing -> merged mesh entities for the posts, each rail level, the toe plate and the gates (06 STA M3). */

import type { CadDocument, Entity, MeshData, Vec3 } from '@core/model/types';
import { fromMm, toMm } from '@core/model/units';
import type { BuildingLevel, RailingElement } from '@aec/building/types';
import { meshEntity } from '../../../building/evaluate/entities';
import { atLevel } from '../../../industrial/evaluate';
import { sweepMesh } from '../../../shared/mesh';
import { findProfile, profileOutline } from '../../../steel/profiles';
import { layoutRailing, type RailRun } from '../railing/railingLayout';
import { toePlateProfile } from '../railing/railingMeasure';
import { mergeMeshes } from './meshParts';

const RAILING_COLOR = '#d4a72c';
const GATE_COLOR = '#c0392b';

export function evaluateRailing(doc: CadDocument, railing: RailingElement, level: BuildingLevel): Entity[] {
  const post = findProfile(railing.postProfile);
  const rail = findProfile(railing.railProfile);
  if (post === undefined || rail === undefined) return [];
  const factor = fromMm(doc, 1);
  const layout = layoutRailing(railing, fromMm(doc, rail.h));
  const world = (point: Vec3): Vec3 => atLevel(level, point);
  const sweep = (profile: typeof post, run: RailRun): MeshData | null => {
    const { outer, holes } = profileOutline(profile);
    return sweepMesh(outer, holes, world(run.from), world(run.to), 0, factor);
  };
  const stub = (part: string, label: string): { part: string; label: string } => ({ part, label: `${label} ${railing.mark}` });
  const entities: Entity[] = [];
  const add = (part: string, label: string, mesh: MeshData | null, color: string): void => {
    if (mesh !== null) entities.push(meshEntity(railing, stub(part, label), mesh, color));
  };
  add(
    'posts',
    'Railing posts',
    mergeMeshes(layout.posts.map((base) => sweep(post, { from: base, to: [base[0], base[1], base[2] + layout.postLength] }))),
    RAILING_COLOR,
  );
  layout.railCentres.forEach((_, index) => {
    const runs = layout.rails.filter((run) => run.level === index);
    add(
      index === 0 ? 'top-rail' : `knee-rail-${index}`,
      index === 0 ? 'Top rail' : 'Knee rail',
      mergeMeshes(runs.map((run) => sweep(rail, run))),
      RAILING_COLOR,
    );
  });
  if (railing.toePlate > 0) {
    const profile = toePlateProfile(toMm(doc, railing.toePlate));
    add('toe-plate', 'Toe plate', mergeMeshes(layout.toePlates.map((run) => sweep(profile, run))), RAILING_COLOR);
  }
  add('gates', 'Gate', mergeMeshes(layout.gates.map((run) => sweep(rail, run))), GATE_COLOR);
  return entities;
}
