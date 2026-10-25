/** Grating panel -> one prism mesh entity (06 STA M2). */

import type { CadDocument, Entity, Vec3 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { toCounterClockwise } from '@lib/polygon';
import type { BuildingLevel, GratingElement } from '@aec/building/types';
import { meshEntity } from '../../../building/evaluate/entities';
import { prismMesh } from '../../../shared/mesh';
import { findGratingType } from '../grating/gratingTypes';

const GRATING_COLOR = '#8f9aa3';

export function evaluateGrating(doc: CadDocument, grating: GratingElement, level: BuildingLevel): Entity[] {
  const type = findGratingType(grating.gratingType);
  if (type === undefined) return [];
  const depth = fromMm(doc, type.barDepthMm);
  const top = level.elevation + grating.topOffset;
  const mesh = prismMesh(toCounterClockwise(grating.boundary), [], ([x, y], side): Vec3 => [x, y, top - depth + side * depth]);
  return mesh === null ? [] : [meshEntity(grating, { part: 'body', label: `Grating ${grating.mark} ${type.name}` }, mesh, GRATING_COLOR)];
}
