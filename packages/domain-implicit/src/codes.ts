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
  IMP_ASSET_MISSING: 'run regenerate_implicit_bodies on this machine (or load the mesh asset store that holds the body)',
  IMP_BODY_STALE:
    'load the mesh asset store that holds the bodies it reads, or run regenerate_implicit_bodies on a machine that can realise them',
  IMP_FIELD_CYCLE: 'reference only fields created earlier that do not depend on the field being edited',
  IMP_FIELD_IN_USE: 'delete the referrers first or pass cascade: true',
  IMP_GRAPH_EMPTY: 'pass lines, polylines, arcs, circles, splines or nurbs_curve ids that hold at least one beam',
  IMP_GRAPH_TOO_LARGE: 'raise chord (fewer samples on curved sources) or split the graph',
  IMP_INPUT_NOT_FOUND:
    'create the input first: run and record the topology study, or mesh and solve the analysis, on a host whose artifact store holds the result',
  IMP_INPUT_TOO_LARGE: 'use a coarser analysis mesh (the limit is in the message)',
  IMP_MAP_SEAM: 'use a whole number of cells around / polar',
  IMP_MAP_SINGULAR: 'pick a regular sheet (no collapsed edge or zero-area patch) or trim the sheet',
  IMP_MAP_TOO_LARGE: 'raise depth (the map grid spacing is depth / 4) or use a smaller sheet',
  IMP_HOMOGENIZATION_TOO_LARGE: 'lower homogenize.resolution (the cap on voxels is in the message)',
  IMP_HOMOGENIZATION_NEEDS_NATIVE: 'run it on the desktop app or the CLI with a backend (the native field engine, llull-compute)',
  IMP_DERIVED_READ_ONLY: 'edit the field nodes and run create_implicit_body again',
};

/** `<command>: <code> — <message>; no-op.` with the code's remediation. */
export const refuseImplicit = tableRejection(REMEDIATION, 'see the command description');
