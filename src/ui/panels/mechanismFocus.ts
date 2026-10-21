// Pure builders of the model highlight (PanelFocus) for the Mechanisms panel rows, and its headline KPIs. Entities of the bodies / instances
// involved are selected; beacons sit at the joint, constraint or load origin with the value as label.

import type { CadDocument, Constraint, DriveRelation, Joint, Vec3 } from '@core/model/types';
import { GROUND, type DynamicsModel } from '@core/model/dynamics';
import type { PanelFocus } from '@ui/store/focusStore';
import type { LoadItem } from '@dynamics/sim/dynamicsLoads';
import { LOAD_COLORS } from '@ui/dynamicsLoads';

export const CONSTRAINT_COLOR = '#ffd740';
export const REVOLUTE_COLOR = '#00e5ff';
export const PRISMATIC_COLOR = '#e040fb';
const DRIVE_COLOR = '#69f0ae';
const BODY_COLOR = '#ff9100';

const ORIGIN: Vec3 = [0, 0, 0];
const positionOf = (doc: CadDocument, id: string): Vec3 => doc.entities[id]?.position ?? ORIGIN;
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

const bodyEntities = (dynamics: DynamicsModel, bodyId: string): string[] =>
  bodyId === GROUND ? [] : (dynamics.bodies[bodyId]?.entityIds ?? []);

/** Entities a rigid-body load acts on: the bodies of its joint / gear pair / body. */
function loadEntityIds(dynamics: DynamicsModel, item: LoadItem): string[] {
  const jointBodies = (jointId: string): string[] => {
    const joint = dynamics.joints[jointId];
    return joint === undefined ? [] : [...bodyEntities(dynamics, joint.child), ...bodyEntities(dynamics, joint.parent)];
  };
  const gear = dynamics.gears[item.id];
  if (gear !== undefined) return unique([...jointBodies(gear.driver), ...jointBodies(gear.driven)]);
  const motor = dynamics.motors[item.id];
  if (motor !== undefined) return unique(jointBodies(motor.joint));
  const propeller = dynamics.propellers[item.id];
  if (propeller !== undefined) return unique(jointBodies(propeller.joint));
  if (item.id.startsWith('weight:')) return unique(bodyEntities(dynamics, item.id.slice('weight:'.length)));
  return unique(jointBodies(item.id));
}

export function loadFocus(doc: CadDocument, item: LoadItem): PanelFocus {
  const markers = [{ position: item.origin, label: item.value }, ...(item.end === undefined ? [] : [{ position: item.end }])];
  return {
    key: `mechanisms:load:${item.id}`,
    label: `${item.title} · ${item.value}`,
    color: LOAD_COLORS[item.layer],
    entityIds: doc.dynamics === undefined ? [] : loadEntityIds(doc.dynamics, item),
    markers,
  };
}

export function bodyFocus(doc: CadDocument, bodyId: string, label: string): PanelFocus {
  const entityIds = doc.dynamics === undefined ? [] : bodyEntities(doc.dynamics, bodyId);
  const first = entityIds[0];
  return {
    key: `mechanisms:body:${bodyId}`,
    label,
    color: BODY_COLOR,
    entityIds,
    markers: first === undefined ? [] : [{ position: positionOf(doc, first), label }],
  };
}

export function constraintFocus(doc: CadDocument, constraint: Constraint): PanelFocus {
  const a = positionOf(doc, constraint.a.entityId);
  const b = positionOf(doc, constraint.b.entityId);
  return {
    key: `mechanisms:constraint:${constraint.id}`,
    label: `${constraint.kind} constraint`,
    color: CONSTRAINT_COLOR,
    entityIds: unique([constraint.a.entityId, constraint.b.entityId]),
    markers: [{ position: a, label: constraint.kind }, { position: b }],
  };
}

export function jointFocus(doc: CadDocument, joint: Joint): PanelFocus {
  const revolute = joint.kind === 'revolute';
  const value = revolute
    ? `${((joint.angle * 180) / Math.PI).toFixed(1)}°`
    : joint.kind === 'prismatic'
      ? `${joint.displacement} ${doc.units}`
      : `[${joint.values.map((v) => +v.toFixed(4)).join(', ')}]`;
  return {
    key: `mechanisms:joint:${joint.id}`,
    label: `${joint.kind} joint`,
    color: revolute ? REVOLUTE_COLOR : PRISMATIC_COLOR,
    entityIds: unique([joint.a.instanceId, joint.b.instanceId]),
    markers: [{ position: positionOf(doc, joint.a.instanceId), label: `${joint.kind} ${value}` }],
  };
}

export function driveFocus(doc: CadDocument, relation: DriveRelation): PanelFocus {
  const instances = [doc.joints[relation.driver], doc.joints[relation.driven]].flatMap((joint) =>
    joint === undefined ? [] : [joint.a.instanceId, joint.b.instanceId],
  );
  const driver = doc.joints[relation.driver];
  return {
    key: `mechanisms:drive:${relation.id}`,
    label: `drive ratio ${relation.ratio.toFixed(3)}`,
    color: DRIVE_COLOR,
    entityIds: unique(instances),
    markers: driver === undefined ? [] : [{ position: positionOf(doc, driver.a.instanceId), label: `ratio ${relation.ratio.toFixed(3)}` }],
  };
}

export interface MechanismCounts {
  readonly movableBodies: number;
  readonly bodies: number;
  readonly joints: number;
  readonly drives: number;
  /** Gruebler estimate: 6 per moving body minus the freedoms each joint removes (a hint, not a proof: redundant constraints). */
  readonly mobility: number;
}

const REMOVED_BY_JOINT = { revolute: 5, prismatic: 5, spherical: 3 } as const;

export function mechanismCounts(doc: CadDocument): MechanismCounts {
  const dynamics = doc.dynamics;
  const bodies = Object.values(dynamics?.bodies ?? {});
  const movableBodies = bodies.filter((body) => !body.fixed).length;
  const dynamicJoints = Object.values(dynamics?.joints ?? {});
  const removed = dynamicJoints.reduce((sum, joint) => sum + REMOVED_BY_JOINT[joint.kind], 0);
  return {
    movableBodies,
    bodies: bodies.length,
    joints: dynamicJoints.length + doc.jointOrder.length,
    drives: Object.keys(dynamics?.motors ?? {}).length + doc.driveRelationOrder.length,
    mobility: Math.max(0, 6 * movableBodies - removed),
  };
}
