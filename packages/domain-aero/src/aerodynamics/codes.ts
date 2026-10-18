/** Stable refusal codes of the aerodynamics plugin (AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  AER_PARAM_INVALID: 'give finite values in the documented units and ranges (see the command description)',
  AER_ALTITUDE_OUT_OF_RANGE: 'the U.S. Standard Atmosphere 1976 model here covers -5 km to 86 km geometric (84.852 km geopotential)',
  AER_AIR_STATE_CONFLICT: 'give either altitude (standard atmosphere) or densityKgM3 (+ viscosityPaS), not both',
  AER_AIRFOIL_INVALID:
    'give a NACA 4-digit (e.g. "2412") or 230-series 5-digit (e.g. "23012") designation, or the id of a closed 2D polyline / spline',
  AER_AIRFOIL_SOURCE_CONFLICT: 'give exactly one of naca or entityId',
  AER_ENTITY_NOT_FOUND: 'list entities with describe_scene / find_entities and pass existing ids',
  AER_NO_GEOMETRY: 'pass 3D solids (2D sketches have no frontal area); instances are expanded through their component',
  AER_SOLVER_FAILED: 'the linear system is singular: check the geometry (duplicate points, zero-length panels, zero chord)',
  AER_AREA_SOURCE_CONFLICT: 'give exactly one of cdA, (cd + referenceArea) or (cd + entityIds)',
  AER_SPEED_SOURCE_CONFLICT: 'give exactly one of speed or powerW',
  AER_NO_EQUILIBRIUM: 'the steady speed would exceed 100 m/s: lower powerW, or the downhill grade / tailwind',
};

export const refuseAero = tableRejection(REMEDIATION);
