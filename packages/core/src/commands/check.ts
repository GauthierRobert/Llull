/**
 * check_model: read-only lint pass (geometry defects, structural inconsistencies, parameter errors).
 *
 * @layer core/commands
 */

import type { CadDocument, Entity } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { boundsCenter, entityBoundsInDoc } from './sceneBounds';
import { len3 } from '../lib/vec3';

/** Severity of a model issue. */
type IssueSeverity = 'error' | 'warning' | 'info';

/** One finding of `check_model`; `entityId` when it concerns a specific entity. */
interface Issue {
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

const issue = (
  severity: IssueSeverity,
  code: string,
  message: string,
  entityId?: string,
): Issue => ({ severity, code, message, ...(entityId !== undefined ? { entityId } : {}) });

/** Degenerate geometry: sizes, radii, and depths that are ≤ 0. */
function checkDegenerateGeometry(e: Entity): Issue[] {
  const label = e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
  const nonPositive = (field: string, value: number, rule: string): Issue[] =>
    value <= 0
      ? [
          issue(
            'error',
            'degenerate_size',
            `${label} entity '${e.id}' has ${field} ${value} ≤ 0. ${rule}`,
            e.id,
          ),
        ]
      : [];
  switch (e.kind) {
    case 'box':
    case 'wedge':
      return e.size.some((c) => c <= 0)
        ? [
            issue(
              'error',
              'degenerate_size',
              `${label} entity '${e.id}' has a zero or negative size component [${e.size.join(', ')}]. All dimensions must be > 0.`,
              e.id,
            ),
          ]
        : [];
    case 'cylinder':
    case 'cone':
      return [
        ...nonPositive('radius', e.radius, 'Radius must be > 0.'),
        ...nonPositive('height', e.height, 'Height must be > 0.'),
      ];
    case 'sphere':
    case 'circle':
    case 'arc':
      return nonPositive('radius', e.radius, 'Radius must be > 0.');
    case 'extrusion':
      return nonPositive('depth', e.depth, 'Depth must be > 0.');
    case 'ellipse':
      return [
        ...nonPositive('radiusX', e.radiusX, 'Both radii must be > 0.'),
        ...nonPositive('radiusY', e.radiusY, 'Both radii must be > 0.'),
      ];
    case 'torus':
      return [
        ...nonPositive('ringRadius', e.ringRadius, 'ringRadius must be > 0.'),
        ...nonPositive('tubeRadius', e.tubeRadius, 'tubeRadius must be > 0.'),
      ];
    case 'pyramid':
      return [
        ...nonPositive('baseWidth', e.baseWidth, 'baseWidth must be > 0.'),
        ...nonPositive('baseDepth', e.baseDepth, 'baseDepth must be > 0.'),
        ...nonPositive('height', e.height, 'Height must be > 0.'),
      ];
    case 'text':
      return [
        ...nonPositive('height', e.height, 'Height must be > 0.'),
        ...(e.content.trim().length === 0
          ? [
              issue(
                'error',
                'degenerate_size',
                `Text entity '${e.id}' has empty content. Content must be a non-empty string.`,
                e.id,
              ),
            ]
          : []),
      ];
    default:
      return [];
  }
}

/** A polyline intended as an extrusion profile must be closed. */
function checkOpenProfile(e: Entity): Issue[] {
  return e.kind === 'polyline' && !e.closed
    ? [
        issue(
          'warning',
          'open_profile',
          `Polyline entity '${e.id}' is not closed. If this polyline is intended as an extrusion profile it must be closed (closed: true).`,
          e.id,
        ),
      ]
    : [];
}

function checkInsufficientPoints(e: Entity): Issue[] {
  if ((e.kind !== 'polyline' && e.kind !== 'spline') || e.points.length >= 2) return [];
  const label = e.kind === 'polyline' ? 'Polyline' : 'Spline';
  return [
    issue(
      'error',
      'insufficient_points',
      `${label} entity '${e.id}' has ${e.points.length} point(s); minimum is 2.`,
      e.id,
    ),
  ];
}

/** Far from origin: bounding-box centre beyond `farThreshold` (viewport precision issues). */
function checkFarFromOrigin(e: Entity, doc: CadDocument, farThreshold: number): Issue[] {
  const center = boundsCenter(entityBoundsInDoc(doc, e));
  const dist = len3(center);
  return dist > farThreshold
    ? [
        issue(
          'warning',
          'far_from_origin',
          `Entity '${e.id}' (kind: ${e.kind}) has its bounding-box center ${dist.toFixed(0)} units from the world origin (threshold: ${farThreshold}). Floating-point precision issues may occur.`,
          e.id,
        ),
      ]
    : [];
}

function checkEmptyLayers(doc: CadDocument): Issue[] {
  const usedLayerIds = new Set(Object.values(doc.entities).map((e) => e.layerId));
  return doc.layerOrder.flatMap((layerId) => {
    const layer = doc.layers[layerId];
    return layer && !usedLayerIds.has(layerId)
      ? [
          issue(
            'info',
            'empty_layer',
            `Layer '${layer.name}' (id: ${layerId}) has no entities assigned to it.`,
          ),
        ]
      : [];
  });
}

function checkOrphanedGroupMembers(doc: CadDocument): Issue[] {
  return Object.values(doc.groups).flatMap((group) =>
    group.memberIds
      .filter((memberId) => !(memberId in doc.entities))
      .map((memberId) =>
        issue(
          'error',
          'orphaned_group_member',
          `Group '${group.name}' (id: ${group.id}) references member id '${memberId}' which does not exist in the document.`,
          memberId,
        ),
      ),
  );
}

function checkDanglingDimensionRefs(entity: Entity, doc: CadDocument): Issue[] {
  if (entity.kind !== 'dimension') return [];
  return entity.entityIds
    .filter((refId) => !(refId in doc.entities))
    .map((refId) =>
      issue(
        'error',
        'dangling_dimension_ref',
        `Dimension entity '${entity.id}' (${entity.dimensionKind}) references entity id '${refId}' which does not exist in the document.`,
        entity.id,
      ),
    );
}

function checkDanglingComponentRef(entity: Entity, doc: CadDocument): Issue[] {
  return entity.kind === 'instance' && !(entity.componentId in doc.components)
    ? [
        issue(
          'error',
          'dangling_component',
          `Instance entity '${entity.id}' references component id '${entity.componentId}' which does not exist in doc.components.`,
          entity.id,
        ),
      ]
    : [];
}

/** Constraints, joints and drive relations pointing at entities/joints that no longer exist. */
function checkDanglingRelations(doc: CadDocument): Issue[] {
  const missing = (kind: string, id: string, refKind: string, refId: string): Issue =>
    issue(
      'error',
      'dangling_reference',
      `${kind} '${id}' references ${refKind} '${refId}' which does not exist in the document.`,
      refId,
    );
  return [
    ...Object.values(doc.constraints ?? {}).flatMap((c) =>
      [c.a.entityId, c.b.entityId]
        .filter((refId) => !Object.hasOwn(doc.entities, refId))
        .map((refId) => missing('Constraint', c.id, 'entity', refId)),
    ),
    ...Object.values(doc.joints ?? {}).flatMap((j) =>
      [j.a.instanceId, j.b.instanceId]
        .filter((refId) => !Object.hasOwn(doc.entities, refId))
        .map((refId) => missing('Joint', j.id, 'instance', refId)),
    ),
    ...Object.values(doc.driveRelations ?? {}).flatMap((r) =>
      [r.driver, r.driven]
        .filter((refId) => !Object.hasOwn(doc.joints, refId))
        .map((refId) => missing('Drive relation', r.id, 'joint', refId)),
    ),
  ];
}

function checkParameterErrors(doc: CadDocument): Issue[] {
  return Object.values(doc.parameters).flatMap((param) =>
    param.error
      ? [
          issue(
            'error',
            'parameter_error',
            `Parameter '${param.name}' has an evaluation error: ${param.error}. Fix the expression or remove this parameter.`,
          ),
        ]
      : [],
  );
}

/** Run every check over the document. @pure */
export function runModelChecks(doc: CadDocument, farThreshold: number): CheckResult {
  const issues = [
    ...Object.values(doc.entities).flatMap((entity) => [
      ...checkDegenerateGeometry(entity),
      ...checkInsufficientPoints(entity),
      ...checkOpenProfile(entity),
      ...checkFarFromOrigin(entity, doc, farThreshold),
    ]),
    ...checkEmptyLayers(doc),
    ...checkOrphanedGroupMembers(doc),
    ...Object.values(doc.entities).flatMap((entity) => checkDanglingDimensionRefs(entity, doc)),
    ...Object.values(doc.entities).flatMap((entity) => checkDanglingComponentRef(entity, doc)),
    ...checkDanglingRelations(doc),
    ...checkParameterErrors(doc),
  ];
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * @command check_model
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned as the SAME reference, affected:[]
 * @invariant data satisfies CheckResult; document === input doc (same reference)
 * @failure never throws; always returns a valid CheckResult in data
 */
export const checkModel = defineCommand({
  name: 'check_model',
  annotations: { readOnly: true },
  description:
    'Scan the document for geometry defects, structural issues, and parameter errors. ' +
    'Returns a structured issue list in `data` ({ ok: boolean, issues: Issue[] }) — ' +
    '`ok` is true when there are no error-severity issues. ' +
    'Does NOT mutate the document. Useful as a lint pass before or after build_project. ' +
    'Issue codes: degenerate_size (zero/negative box/cylinder/sphere/extrusion/circle/arc/ellipse/cone/torus/wedge/pyramid dimension), ' +
    'open_profile (polyline not closed), insufficient_points (polyline/spline < 2 points), ' +
    'far_from_origin (entity center > farThreshold units from world origin), ' +
    'empty_layer (layer with no entities), orphaned_group_member (group references missing entity id), ' +
    'dangling_dimension_ref (dimension entity references a missing entity id), ' +
    'dangling_reference (constraint/joint/drive relation references a missing entity or joint), ' +
    'parameter_error (a named parameter has an evaluation error).',
  params: z.object({
    farThreshold: z
      .number()
      .optional()
      .describe(
        'Distance from world origin beyond which an entity bounding-box center is flagged ' +
          'as a far_from_origin warning. Units match the document units. Default: 1000000.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const farThreshold = params.farThreshold ?? 1e6;
    const result = runModelChecks(doc, farThreshold);

    const count = (severity: IssueSeverity): number =>
      result.issues.filter((i) => i.severity === severity).length;

    const summary =
      result.issues.length === 0
        ? 'check_model: no issues found — model is clean.'
        : `check_model: ${result.issues.length} issue(s) — ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} info(s). ok=${result.ok}.`;

    return {
      document: doc,
      summary,
      affected: [],
      data: result,
    };
  },
});
