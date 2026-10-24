/**
 * Display geometry of the M2 parts (02 RTE §5.11): valve body + stem + handwheel disc, reducer frustum, tee (header cylinder + branch stub) and
 * olet. Schematic, never used by a check: sizes come from the part's dims, stem and wheel from the catalogue `stemHeight` when the row has one,
 * else a named display proportion. A part draws one entity with its own id plus, for a tee and a valve, extra entities `<id>/branch`,
 * `<id>/stem`, `<id>/wheel`.
 */

import type { Entity, RevolutionEntity } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeLine, RoutedPart } from '@aec/plant/types';
import { add3, len3, scale3, sub3 } from '@lib/vec3';
import { operatorBodies, type OperatorKind } from './operator';
import {
  axisOf,
  entityOf,
  FITTING_LAYER_ID,
  partEntity,
  RADIAL_SEGMENTS,
  rotationToward,
  VALVE_LAYER_ID,
  type LayerId,
  type Section,
} from './geometry';

/** Display proportions (fractions of the pipe outside diameter), named so nobody reads them as catalogue dimensions. */
const VALVE_BODY_RADIUS = 0.7;
const STEM_RADIUS = 0.08;
const WHEEL_RADIUS = 0.55;
const WHEEL_THICKNESS = 0.06;
const OLET_RADIUS = 0.65;
const OPERATOR_LABEL: Readonly<Record<OperatorKind, string>> = { handwheel: 'Handwheel', gear: 'Gear operator', actuator: 'Actuator' };

/** Stem length when the catalogue row gives no `stemHeight`, as a fraction of the face-to-face length. */
const STEM_FRACTION_OF_LENGTH = 0.9;

/** A solid cylinder from `from` along the unit `axis`. */
function cylinder(
  part: RoutedPart,
  line: PipeLine,
  layer: LayerId,
  label: string,
  from: Vec3,
  axis: Vec3,
  length: number,
  radius: number,
): RevolutionEntity {
  const profile: Section = [
    [0, 0],
    [radius, 0],
    [radius, length],
    [0, length],
  ];
  return entityOf(part, line, layer, label, { position: from, rotation: rotationToward(axis) }, profile, 2 * Math.PI, RADIAL_SEGMENTS);
}

const withId = (entity: RevolutionEntity, id: string): RevolutionEntity => ({ ...entity, id });

function valveEntities(part: RoutedPart, line: PipeLine): Entity[] {
  const frame = axisOf(part.ports);
  const od = part.dims['outsideDiameter'];
  if (frame === null || od === undefined) return [];
  const entities: Entity[] = [
    cylinder(part, line, VALVE_LAYER_ID, 'Valve', frame.origin, frame.axis, frame.length, (od / 2) * (1 + VALVE_BODY_RADIUS)),
  ];
  const stem = part.stemDirection;
  if (part.centre === undefined || stem === undefined || !(len3(stem) > 0)) return entities;
  const length = part.dims['stemHeight'] ?? frame.length * STEM_FRACTION_OF_LENGTH;
  entities.push(withId(cylinder(part, line, VALVE_LAYER_ID, 'Valve stem', part.centre, stem, length, od * STEM_RADIUS), `${part.id}/stem`));
  const operator = operatorBodies(part);
  // A row that describes its operator (handwheel diameter, gear box, actuator) is drawn from those dimensions; otherwise the named display proportions.
  if (operator.length > 0) {
    for (const body of operator)
      entities.push(
        withId(
          cylinder(part, line, VALVE_LAYER_ID, OPERATOR_LABEL[body.kind], body.from, body.axis, body.lengthMm, body.radiusMm),
          body.id,
        ),
      );
    return entities;
  }
  const wheelAt = add3(part.centre, scale3(stem, length));
  entities.push(
    withId(cylinder(part, line, VALVE_LAYER_ID, 'Handwheel', wheelAt, stem, od * WHEEL_THICKNESS, od * WHEEL_RADIUS), `${part.id}/wheel`),
  );
  return entities;
}

function reducerEntities(part: RoutedPart, line: PipeLine): Entity[] {
  const frame = axisOf(part.ports);
  const [big, small] = [part.dims['outsideDiameter'], part.dims['outsideDiameterOut']];
  if (frame === null || big === undefined || small === undefined) return [];
  const profile: Section = [
    [0, 0],
    [big / 2, 0],
    [small / 2, frame.length],
    [0, frame.length],
  ];
  return [
    entityOf(
      part,
      line,
      FITTING_LAYER_ID,
      'Reducer',
      { position: frame.origin, rotation: rotationToward(frame.axis) },
      profile,
      2 * Math.PI,
      RADIAL_SEGMENTS,
    ),
  ];
}

function teeEntities(part: RoutedPart, line: PipeLine): Entity[] {
  const frame = axisOf(part.ports);
  const [header, branch] = [part.dims['outsideDiameter'], part.dims['branchOutsideDiameter']];
  const outlet = part.ports[2];
  if (frame === null || header === undefined || branch === undefined || outlet === undefined || part.centre === undefined) return [];
  const reach = sub3(outlet.position, part.centre);
  const length = len3(reach);
  if (!(length > 0)) return [];
  return [
    cylinder(part, line, FITTING_LAYER_ID, 'Tee', frame.origin, frame.axis, frame.length, header / 2),
    withId(
      cylinder(part, line, FITTING_LAYER_ID, 'Tee branch', part.centre, scale3(reach, 1 / length), length, branch / 2),
      `${part.id}/branch`,
    ),
  ];
}

function oletEntities(part: RoutedPart, line: PipeLine): Entity[] {
  const frame = axisOf(part.ports);
  const branch = part.dims['branchOutsideDiameter'];
  if (frame === null || branch === undefined) return [];
  return [cylinder(part, line, FITTING_LAYER_ID, 'Olet', frame.origin, frame.axis, frame.length, (branch / 2) * (1 + OLET_RADIUS))];
}

/** The display entities of `part` (none for a bolt set or a stub-in; valves, tees: more than one). */
export function partEntities(part: RoutedPart, line: PipeLine): Entity[] {
  switch (part.kind) {
    case 'valve':
      return valveEntities(part, line);
    case 'reducer':
      return reducerEntities(part, line);
    case 'tee':
      return teeEntities(part, line);
    case 'olet':
      return oletEntities(part, line);
    default: {
      const entity = partEntity(part, line);
      return entity === null ? [] : [entity];
    }
  }
}
