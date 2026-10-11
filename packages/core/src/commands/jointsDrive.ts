import type { CadDocument, DriveRelation } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { nextId } from '../lib/id';
import { detectCycleOnAdd, evaluateMotionInternal } from './jointsKinematics';
import { changed, noop, report } from './noop';
/**
 * @command add_drive_relation
 * @pure
 * @layer core/commands
 * @affects appends 1 entry to doc.driveRelations and doc.driveRelationOrder
 * @invariant driver and driven must exist in doc.joints
 * @invariant driver !== driven (no self-coupling)
 * @invariant the resulting drive graph must be acyclic
 * @failure unknown joint id / self-coupling / cycle → no-op, affected:[]
 */
export const addDriveRelation = defineCommand({
  name: 'add_drive_relation',
  description:
    'Couple two kinematic joints: driven_value = driver_value * ratio + offset. ' +
    'Models gear trains (ratio = gear_ratio), belt drives, cam followers, or any linear coupling. ' +
    'Example: two meshing gears with 2:1 ratio — set ratio=2. ' +
    '"driver" is the source joint id (its value propagates). ' +
    '"driven" is the target joint id (its value is computed from the driver). ' +
    '"ratio" is the multiplication factor (may be negative for direction reversal). ' +
    '"offset" is an optional additive phase or position offset (default 0). ' +
    'Cyclic couplings (A→B→A) are rejected with an explanatory summary. ' +
    'Returns the new drive relation id in affected[0].',
  params: z.object({
    driver: z
      .string()
      .describe('Id of the driving joint (source of motion). Must exist in doc.joints.'),
    driven: z
      .string()
      .describe('Id of the driven joint (receives motion). Must exist in doc.joints.'),
    ratio: z
      .number()
      .describe(
        'Coupling ratio: driven = driver * ratio + offset. ' +
          'Use 1.0 for a direct coupling, 2.0 for a 2:1 gear-up, -1.0 to reverse direction.',
      ),
    offset: z
      .number()
      .optional()
      .describe('Optional additive offset applied after ratio multiplication. Default: 0.'),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit drive relation id. When omitted a unique id is generated. ' +
          'If the id already exists in doc.driveRelations the command is a no-op.',
      ),
  }),
  run: (doc, { driver, driven, ratio, offset, id }): CommandResult => {
    if (!(driver in doc.joints)) {
      return noop(
        doc,
        `add_drive_relation: driver joint '${String(driver)}' does not exist in doc.joints.`,
      );
    }
    if (!(driven in doc.joints)) {
      return noop(
        doc,
        `add_drive_relation: driven joint '${String(driven)}' does not exist in doc.joints.`,
      );
    }
    if (driver === driven) {
      return noop(
        doc,
        `add_drive_relation: driver and driven cannot be the same joint ('${driver}').`,
      );
    }
    // Cycle detection
    const cyclePath = detectCycleOnAdd(doc.driveRelations, driver, driven);
    if (cyclePath !== null) {
      return noop(
        doc,
        `add_drive_relation: adding this relation would create a cycle: ${cyclePath}. No change made.`,
      );
    }

    const drId = typeof id === 'string' && id.length > 0 ? id : nextId('dr');
    if (drId in doc.driveRelations) {
      return noop(
        doc,
        `add_drive_relation: drive relation id '${drId}' already exists — no change made.`,
      );
    }

    const newDr: DriveRelation = {
      id: drId,
      driver,
      driven,
      ratio,
      ...(offset !== undefined ? { offset } : {}),
    };

    const newDoc: CadDocument = {
      ...doc,
      driveRelations: { ...doc.driveRelations, [drId]: newDr },
      driveRelationOrder: [...doc.driveRelationOrder, drId],
    };

    return changed(
      newDoc,
      `add_drive_relation: coupled '${driver}' → '${driven}' with ratio=${ratio}` +
        (offset !== undefined ? ` offset=${offset}` : '') +
        ` (id: '${drId}').`,
      [drId],
    );
  },
});

/**
 * @command delete_drive_relation
 * @pure
 * @layer core/commands
 * @affects removes 1 entry from doc.driveRelations and doc.driveRelationOrder
 * @invariant driveRelationOrder and driveRelations remain consistent after deletion
 * @failure unknown drive relation id → no-op, affected:[]
 */
export const deleteDriveRelation = defineCommand({
  name: 'delete_drive_relation',
  annotations: { destructive: true },
  description:
    'Remove a drive relation (joint coupling) from the document by its id. ' +
    'The joints themselves are not affected; only the coupling is removed. ' +
    'If the drive relation id does not exist the document is left unchanged.',
  params: z.object({
    id: z
      .string()
      .describe(
        'Id of the drive relation to remove. Must match an existing entry in doc.driveRelations.',
      ),
  }),
  run: (doc, { id }): CommandResult => {
    const dr = Object.hasOwn(doc.driveRelations, id) ? doc.driveRelations[id] : undefined;
    if (!dr) {
      return noop(
        doc,
        `delete_drive_relation: drive relation '${String(id)}' does not exist — no change made.`,
      );
    }

    const newDriveRelations = { ...doc.driveRelations };
    delete newDriveRelations[id];

    const newDoc: CadDocument = {
      ...doc,
      driveRelations: newDriveRelations,
      driveRelationOrder: doc.driveRelationOrder.filter((drid) => drid !== id),
    };

    return report(
      newDoc,
      `delete_drive_relation: removed coupling '${dr.driver}' → '${dr.driven}' (id: '${id}').`,
    );
  },
});

/**
 * @command evaluate_motion
 * @pure
 * @layer core/commands
 * @affects nothing — read-only query, affected:[]
 * @invariant document is returned unchanged; resolved joint values propagated in topo order
 * @failure no joints → empty data, friendly summary; unknown instanceIds → those joints skipped
 */
export const evaluateMotion = defineCommand({
  name: 'evaluate_motion',
  annotations: { readOnly: true, metaHistory: true },
  description:
    'Compute the result of applying all kinematic joints and drive relations without mutating the document. ' +
    'Drive relations are walked in topological order: driven_value = driver_value * ratio + offset. ' +
    "Then each joint is applied: revolute rotates instance b around instance a's origin along the axis; " +
    "prismatic translates instance b along the axis from instance a's origin. " +
    'Returns the document unchanged with affected:[] and data: ' +
    '{ resolvedJoints: Record<jointId, number>, ' +
    '  instancePositions: Record<instanceId, Vec3>, ' +
    '  instanceRotations: Record<instanceId, Vec3> }. ' +
    'Call bake_motion to permanently apply these transforms to the document.',
  params: z.object({}),
  run: (doc, _params): CommandResult => {
    if (Object.keys(doc.joints).length === 0) {
      return report(doc, 'evaluate_motion: no joints defined. Nothing to evaluate.', {
        resolvedJoints: {},
        instancePositions: {},
        instanceRotations: {},
      });
    }

    const { resolvedJoints, instancePositions, instanceRotations } = evaluateMotionInternal(doc);

    const jointCount = Object.keys(resolvedJoints).length;
    const movedCount = Object.keys(instancePositions).length;

    return report(
      doc,
      `evaluate_motion: evaluated ${jointCount} joint(s), ${movedCount} instance(s) would move.`,
      { resolvedJoints, instancePositions, instanceRotations },
    );
  },
});

/**
 * @command bake_motion
 * @pure
 * @layer core/commands
 * @affects updates position and rotation of instance entities in doc.entities
 * @invariant joint values and drive relations are unchanged; only instance transforms change
 * @failure no joints → no-op with friendly summary
 */
export const bakeMotion = defineCommand({
  name: 'bake_motion',
  description:
    'Apply all kinematic joints and drive relations to the document, permanently updating ' +
    'the position and rotation of affected InstanceEntity objects. ' +
    'This runs the same calculation as evaluate_motion but WRITES the results into the document. ' +
    'Drive relations are walked in topological order; each joint is then applied to instance b. ' +
    "Revolute joint: rotates instance b around instance a's origin along the axis by the joint angle. " +
    "Prismatic joint: translates instance b along the axis from instance a's origin by the displacement. " +
    'Returns the updated document with affected[] listing all modified instance ids.',
  params: z.object({}),
  run: (doc, _params): CommandResult => {
    if (Object.keys(doc.joints).length === 0)
      return noop(doc, 'bake_motion: no joints defined. Nothing to bake.');

    const { resolvedJoints, instancePositions, instanceRotations } = evaluateMotionInternal(doc);

    const movedIds = Object.keys(instancePositions);
    if (movedIds.length === 0) {
      return report(
        doc,
        'bake_motion: joints exist but no instance positions changed (all instanceIds may be missing).',
      );
    }

    // Apply computed positions and rotations to entities
    const newEntities = { ...doc.entities };
    for (const instanceId of movedIds) {
      const existing = newEntities[instanceId];
      const position = instancePositions[instanceId];
      if (!existing || !position) continue;
      newEntities[instanceId] = {
        ...existing,
        position,
        rotation: instanceRotations[instanceId] ?? existing.rotation,
      };
    }

    const jointCount = Object.keys(resolvedJoints).length;

    const newDoc: CadDocument = {
      ...doc,
      entities: newEntities,
    };

    return changed(
      newDoc,
      `bake_motion: applied ${jointCount} joint(s); updated position/rotation of ${movedIds.length} instance(s): ${movedIds.join(', ')}.`,
      movedIds,
    );
  },
});
