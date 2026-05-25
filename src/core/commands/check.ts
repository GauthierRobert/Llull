/**
 * Model validation — read-only lint pass over the document.
 *
 * `check_model` scans the document for common geometry defects, structural
 * inconsistencies, and parameter errors. It is the agent's "lint before/after
 * build_project" step. It never mutates the document.
 *
 * @command check_model
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned as the SAME reference, affected:[]
 * @invariant data is a CheckResult; document === input doc (same reference)
 * @failure no params required; optional farThreshold defaults to 1e6
 */

import type { CadDocument, Entity } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { entityBounds } from './scene';

// ---------------------------------------------------------------------------
// Public types (part of the command result shape)
// ---------------------------------------------------------------------------

/** Severity of a model issue. */
export type IssueSeverity = 'error' | 'warning' | 'info';

/**
 * A single model issue discovered by `check_model`.
 * `entityId` is present when the issue is associated with a specific entity.
 */
export interface Issue {
  severity: IssueSeverity;
  /** Short machine-readable tag identifying the issue class. */
  code: string;
  /** Human/AI-readable explanation of what was found and why it is a problem. */
  message: string;
  /** Id of the entity the issue concerns, when applicable. */
  entityId?: string;
}

/** Structured result returned in `CommandResult.data` by `check_model`. */
export interface CheckResult {
  /** True when no `error`-severity issues were found. */
  ok: boolean;
  issues: Issue[];
}

// ---------------------------------------------------------------------------
// Check parameters
// ---------------------------------------------------------------------------

interface CheckModelParams {
  farThreshold?: number;
}

// ---------------------------------------------------------------------------
// Individual check functions — each returns Issue[] for its concern
// ---------------------------------------------------------------------------

/**
 * Degenerate geometry: sizes, radii, and depths that are ≤ 0.
 * A solid with a zero/negative dimension cannot be rendered or exported.
 */
function checkDegenerateGeometry(e: Entity): Issue[] {
  const issues: Issue[] = [];

  switch (e.kind) {
    case 'box': {
      const [w, h, d] = e.size;
      if (w <= 0 || h <= 0 || d <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Box entity '${e.id}' has a zero or negative size component [${w}, ${h}, ${d}]. All dimensions must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'cylinder': {
      if (e.radius <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Cylinder entity '${e.id}' has radius ${e.radius} ≤ 0. Radius must be > 0.`,
          entityId: e.id,
        });
      }
      if (e.height <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Cylinder entity '${e.id}' has height ${e.height} ≤ 0. Height must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'sphere': {
      if (e.radius <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Sphere entity '${e.id}' has radius ${e.radius} ≤ 0. Radius must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'extrusion': {
      if (e.depth <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Extrusion entity '${e.id}' has depth ${e.depth} ≤ 0. Depth must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'circle': {
      if (e.radius <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Circle entity '${e.id}' has radius ${e.radius} ≤ 0. Radius must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'arc': {
      if (e.radius <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Arc entity '${e.id}' has radius ${e.radius} ≤ 0. Radius must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    case 'ellipse': {
      if (e.radiusX <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Ellipse entity '${e.id}' has radiusX ${e.radiusX} ≤ 0. Both radii must be > 0.`,
          entityId: e.id,
        });
      }
      if (e.radiusY <= 0) {
        issues.push({
          severity: 'error',
          code: 'degenerate_size',
          message: `Ellipse entity '${e.id}' has radiusY ${e.radiusY} ≤ 0. Both radii must be > 0.`,
          entityId: e.id,
        });
      }
      break;
    }
    // 'line', 'polyline', 'rectangle', 'point', 'spline', 'mesh' handled elsewhere or N/A
  }

  return issues;
}

/**
 * Open profile warning: a polyline that is not closed.
 * Relevant when a 2D profile is intended to be used with `extrude_sketch`.
 */
function checkOpenProfile(e: Entity): Issue[] {
  if (e.kind !== 'polyline') return [];
  if (!e.closed) {
    return [
      {
        severity: 'warning',
        code: 'open_profile',
        message: `Polyline entity '${e.id}' is not closed. If this polyline is intended as an extrusion profile it must be closed (closed: true).`,
        entityId: e.id,
      },
    ];
  }
  return [];
}

/**
 * Insufficient points: spline with < 2 points, polyline with < 2 points.
 */
function checkInsufficientPoints(e: Entity): Issue[] {
  if (e.kind === 'polyline' && e.points.length < 2) {
    return [
      {
        severity: 'error',
        code: 'insufficient_points',
        message: `Polyline entity '${e.id}' has ${e.points.length} point(s); minimum is 2.`,
        entityId: e.id,
      },
    ];
  }
  if (e.kind === 'spline' && e.points.length < 2) {
    return [
      {
        severity: 'error',
        code: 'insufficient_points',
        message: `Spline entity '${e.id}' has ${e.points.length} point(s); minimum is 2.`,
        entityId: e.id,
      },
    ];
  }
  return [];
}

/**
 * Far from origin: bounding-box center beyond `farThreshold` units.
 * Objects far from the origin cause floating-point precision issues in the viewport.
 */
function checkFarFromOrigin(e: Entity, farThreshold: number): Issue[] {
  const bounds = entityBounds(e);
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const dist = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (dist > farThreshold) {
    return [
      {
        severity: 'warning',
        code: 'far_from_origin',
        message: `Entity '${e.id}' (kind: ${e.kind}) has its bounding-box center ${dist.toFixed(0)} units from the world origin (threshold: ${farThreshold}). Floating-point precision issues may occur.`,
        entityId: e.id,
      },
    ];
  }
  return [];
}

/**
 * Empty layers: layers that have no entities assigned to them.
 */
function checkEmptyLayers(doc: CadDocument): Issue[] {
  const issues: Issue[] = [];
  const entityLayerIds = new Set(Object.values(doc.entities).map((e) => e.layerId));

  for (const layerId of doc.layerOrder) {
    const layer = doc.layers[layerId];
    if (!layer) continue;
    if (!entityLayerIds.has(layerId)) {
      issues.push({
        severity: 'info',
        code: 'empty_layer',
        message: `Layer '${layer.name}' (id: ${layerId}) has no entities assigned to it.`,
      });
    }
  }
  return issues;
}

/**
 * Orphaned group members: a group referencing an entity id not in `entities`.
 */
function checkOrphanedGroupMembers(doc: CadDocument): Issue[] {
  const issues: Issue[] = [];
  for (const group of Object.values(doc.groups)) {
    for (const memberId of group.memberIds) {
      if (!(memberId in doc.entities)) {
        issues.push({
          severity: 'error',
          code: 'orphaned_group_member',
          message: `Group '${group.name}' (id: ${group.id}) references member id '${memberId}' which does not exist in the document.`,
          entityId: memberId,
        });
      }
    }
  }
  return issues;
}

/**
 * Parameter errors: parameters whose `error` field is set.
 */
function checkParameterErrors(doc: CadDocument): Issue[] {
  const issues: Issue[] = [];
  for (const param of Object.values(doc.parameters)) {
    if (param.error) {
      issues.push({
        severity: 'error',
        code: 'parameter_error',
        message: `Parameter '${param.name}' has an evaluation error: ${param.error}. Fix the expression or remove this parameter.`,
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Main validation runner
// ---------------------------------------------------------------------------

/**
 * Run all checks over the document and collect the full issue list.
 *
 * @pure — reads the document, never mutates it.
 * @layer core/commands
 */
export function runModelChecks(doc: CadDocument, farThreshold: number): CheckResult {
  const issues: Issue[] = [];

  // Per-entity checks
  for (const entity of Object.values(doc.entities)) {
    issues.push(...checkDegenerateGeometry(entity));
    issues.push(...checkInsufficientPoints(entity));
    issues.push(...checkOpenProfile(entity));
    issues.push(...checkFarFromOrigin(entity, farThreshold));
  }

  // Document-level checks
  issues.push(...checkEmptyLayers(doc));
  issues.push(...checkOrphanedGroupMembers(doc));
  issues.push(...checkParameterErrors(doc));

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues };
}

// ---------------------------------------------------------------------------
// check_model command definition
// ---------------------------------------------------------------------------

/**
 * @command check_model
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned as the SAME reference, affected:[]
 * @invariant data satisfies CheckResult; document === input doc (same reference)
 * @failure never throws; always returns a valid CheckResult in data
 */
export const checkModel: CommandDefinition<CheckModelParams> = {
  name: 'check_model',
  description:
    'Scan the document for geometry defects, structural issues, and parameter errors. ' +
    'Returns a structured issue list in `data` ({ ok: boolean, issues: Issue[] }) — ' +
    '`ok` is true when there are no error-severity issues. ' +
    'Does NOT mutate the document. Useful as a lint pass before or after build_project. ' +
    'Issue codes: degenerate_size (zero/negative box/cylinder/sphere/extrusion/circle/arc/ellipse dimension), ' +
    'open_profile (polyline not closed), insufficient_points (polyline/spline < 2 points), ' +
    'far_from_origin (entity center > farThreshold units from world origin), ' +
    'empty_layer (layer with no entities), orphaned_group_member (group references missing entity id), ' +
    'parameter_error (a named parameter has an evaluation error).',
  paramsSchema: {
    type: 'object',
    properties: {
      farThreshold: {
        type: 'number',
        description:
          'Distance from world origin beyond which an entity bounding-box center is flagged ' +
          'as a far_from_origin warning. Units match the document units. Default: 1000000.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const farThreshold = (params as CheckModelParams).farThreshold ?? 1e6;
    const result = runModelChecks(doc, farThreshold);

    const errorCount = result.issues.filter((i) => i.severity === 'error').length;
    const warnCount = result.issues.filter((i) => i.severity === 'warning').length;
    const infoCount = result.issues.filter((i) => i.severity === 'info').length;

    const summary =
      result.issues.length === 0
        ? 'check_model: no issues found — model is clean.'
        : `check_model: ${result.issues.length} issue(s) — ${errorCount} error(s), ${warnCount} warning(s), ${infoCount} info(s). ok=${result.ok}.`;

    return {
      document: doc,
      summary,
      affected: [],
      data: result,
    };
  },
};
