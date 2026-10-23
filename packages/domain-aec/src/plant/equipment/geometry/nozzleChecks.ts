/**
 * Checks of a nozzle against its equipment (plant 03 EQP §5.4, §7): refusals (`EQP_PARAM_INVALID`, `EQP_NOZZLE_OFF_BODY`,
 * `EQP_NOZZLE_PROJECTION_TOO_SHORT`) and warnings (`EQP_NOZZLE_IN_KNUCKLE`, `EQP_NOZZLE_OVERLAP`).
 */

import type { EquipmentTemplate, NozzleRecord, VesselTemplate } from '../plantData';
import { headSurfaceHeight, inKnuckleZone, resolveVessel, type VesselGeometry } from './vesselFrame';
import { placeNozzle } from './ports';

export interface NozzleIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

const issue = (code: string, message: string, path: string): NozzleIssue => ({ code, message, path });

function shellIssue(template: VesselTemplate, nozzle: NozzleRecord): NozzleIssue | null {
  const { location } = nozzle;
  if (location.on !== 'shell') return null;
  const vertical = template.orientation === 'vertical';
  if (vertical !== 'elevation' in location)
    return issue(
      'EQP_PARAM_INVALID',
      vertical
        ? 'a vertical vessel takes a shell location by elevation, not station'
        : 'a horizontal vessel takes a shell location by station, not elevation',
      vertical ? 'location.elevation' : 'location.station',
    );
  const [value, name] = 'elevation' in location ? [location.elevation, 'elevation'] : [location.station, 'station'];
  if (!(value >= 0 && value <= template.tangentLength))
    return issue('EQP_NOZZLE_OFF_BODY', `${name} ${value} is outside the shell 0..${template.tangentLength}`, `location.${name}`);
  return null;
}

function headIssue(template: VesselTemplate, geometry: VesselGeometry, nozzle: NozzleRecord): NozzleIssue | null {
  const { location } = nozzle;
  if (location.on !== 'head') return null;
  const heads = template.orientation === 'vertical' ? ['top', 'bottom'] : ['left', 'right'];
  if (!heads.includes(location.head))
    return issue(
      'EQP_PARAM_INVALID',
      `a ${template.orientation} vessel has ${heads.join(' and ')} heads, not ${location.head}`,
      'location.head',
    );
  if (!(location.radialOffset >= 0 && location.radialOffset < geometry.radius))
    return issue(
      'EQP_NOZZLE_OFF_BODY',
      `radialOffset ${location.radialOffset} must be inside the head, 0 <= offset < ${geometry.radius}`,
      'location.radialOffset',
    );
  return null;
}

/** Face distance below which the flange would sit inside the wall (shell: axis to face; head: tangent line to face). */
function minimumProjection(geometry: VesselGeometry, nozzle: NozzleRecord): number {
  const { location, flange } = nozzle;
  if (location.on === 'shell') return geometry.radius + geometry.shellThickness + flange.thickness;
  if (location.on === 'head') {
    const first = location.head === 'bottom' || location.head === 'left';
    const shape = first ? geometry.first : geometry.second;
    return headSurfaceHeight(shape, geometry.radius, location.radialOffset) + geometry.headThickness + flange.thickness;
  }
  return flange.thickness;
}

/**
 * First reason `nozzle` cannot sit on `template`, or null.
 * @failure location kind not suited to the template -> EQP_PARAM_INVALID; outside the body -> EQP_NOZZLE_OFF_BODY; face inside the wall +
 *   flange -> EQP_NOZZLE_PROJECTION_TOO_SHORT
 */
export function nozzleProblem(template: EquipmentTemplate, nozzle: NozzleRecord): NozzleIssue | null {
  if (nozzle.location.on === 'free') {
    const [dx, dy, dz] = nozzle.location.direction;
    if (Math.hypot(dx, dy, dz) < 1e-12) return issue('EQP_PARAM_INVALID', 'direction must not be the zero vector', 'location.direction');
    return nozzle.projection > nozzle.flange.thickness
      ? null
      : issue(
          'EQP_NOZZLE_PROJECTION_TOO_SHORT',
          `projection ${nozzle.projection} must exceed the flange thickness ${nozzle.flange.thickness}`,
          'projection',
        );
  }
  if (template.kind !== 'vessel')
    return issue(
      'EQP_PARAM_INVALID',
      'legacy block equipment has no shell or head: give location { on: "free", position, direction }',
      'location.on',
    );
  const geometry = resolveVessel(template);
  if ('error' in geometry) return issue('EQP_HEAD_INVALID', geometry.error, geometry.path);
  const located = shellIssue(template, nozzle) ?? headIssue(template, geometry, nozzle);
  if (located !== null) return located;
  const minimum = minimumProjection(geometry, nozzle);
  return nozzle.projection >= minimum
    ? null
    : issue(
        'EQP_NOZZLE_PROJECTION_TOO_SHORT',
        `projection ${nozzle.projection} puts the flange face inside the wall; it must be at least ${minimum} (wall + flange thickness ${nozzle.flange.thickness})`,
        'projection',
      );
}

/** Non-blocking findings: head nozzle in the knuckle zone, reinforcement zones (2 x neck OD circles) that intersect another nozzle's. */
export function nozzleWarnings(template: EquipmentTemplate, nozzle: NozzleRecord, others: readonly NozzleRecord[]): NozzleIssue[] {
  const warnings: NozzleIssue[] = [];
  if (template.kind === 'vessel' && nozzle.location.on === 'head') {
    const geometry = resolveVessel(template);
    if (!('error' in geometry)) {
      const first = nozzle.location.head === 'bottom' || nozzle.location.head === 'left';
      if (inKnuckleZone(first ? geometry.first : geometry.second, geometry.radius, nozzle.location.radialOffset))
        warnings.push(
          issue(
            'EQP_NOZZLE_IN_KNUCKLE',
            'the nozzle is in the knuckle zone (or beyond 0.8 R): move it toward the centre',
            'location.radialOffset',
          ),
        );
    }
  }
  const mine = placeNozzle(template, nozzle);
  if (mine === null || nozzle.location.on === 'free') return warnings;
  for (const other of others) {
    const theirs = other.location.on === 'free' || other.mark === nozzle.mark ? null : placeNozzle(template, other);
    if (theirs === null) continue;
    const distance = Math.hypot(mine.base[0] - theirs.base[0], mine.base[1] - theirs.base[1], mine.base[2] - theirs.base[2]);
    if (distance < nozzle.neckOutsideDiameter + other.neckOutsideDiameter)
      warnings.push(issue('EQP_NOZZLE_OVERLAP', `reinforcement zone intersects nozzle ${other.mark}`, 'location'));
  }
  return warnings;
}
