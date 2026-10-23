/** Stable refusal codes of the implicit plugin (05 IMP §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  IMP_PARAM_RANGE: 'give a positive value in document units (rounding below half the smallest size)',
  IMP_PARAM_CONFLICT: 'give exactly one of thickness, level, relativeDensity',
  IMP_FIELD_NOT_FOUND: 'list the fields with implicit_properties or describe_scene, or create one with add_field_primitive',
  IMP_ENTITY_NOT_FOUND: 'list the entities with describe_scene',
  IMP_SOLID_NOT_CLOSED: 'pick a closed 3D solid, or close the mesh first (sew_surfaces, repair_mesh)',
  IMP_TPMS_CONTROL_RANGE: 'use the valid interval named in the message',
  IMP_STRUT_RADIUS_RANGE: 'reduce the radius or enlarge the cell',
  IMP_FIELD_UNBOUNDED: 'intersect the field with a region (add_field_primitive box) or pass bounds',
  IMP_GRID_BUDGET: 'use a coarser voxel, smaller bounds, or install / use the native field engine (kernel_info)',
  IMP_TRIANGLE_BUDGET: 'use a coarser voxel or raise maxTriangles',
  IMP_BODY_EMPTY: 'check the sign convention (negative inside) and the region',
  IMP_ENGINE_FAILED: 'retry, or use a coarser voxel (TS engine)',
  IMP_DERIVED_READ_ONLY: 'edit the field nodes and run create_implicit_body again',
};

/** `<command>: <code> — <message>; no-op.` with the code's remediation. */
export const refuseImplicit = tableRejection(REMEDIATION, 'see the command description');
