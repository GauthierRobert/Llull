import type { CadDocument, DriveRelation } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { idOrNext, idTaken } from '../entity/explicitId';
import { detectCycleOnAdd, evaluateMotionInternal } from './jointsKinematics';
import { changed, noop, report } from '../noop';
/**
 * @affects appends 1 entry to doc.driveRelations and doc.driveRelationOrder
 * @invariant driver and driven must exist in doc.joints
 * @invariant driver !== driven (no self-coupling)
 * @invariant the resulting drive graph must be acyclic
 * @failure unknown joint id / self-coupling / cycle → no-op, affected:[]
 */
export const addDriveRelation = defineCommand({
  name: 'add_drive_relation',
  description:
    'Couple two kinematic joints (add_joint; poses only, no inertia): driven_value = driver_value * ratio + offset. ' +
    'Models gear trains (ratio = gear_ratio), belt drives, cam followers, or any linear coupling. ' +
    'Example: two meshing gears with 2:1 ratio — set ratio=2. "driver" is the source joint id (its value propagates). ' +
    '"driven" is the target joint id (its value is computed from the driver). ' +
    '"ratio" is the multiplication factor (may be negative for direction reversal). ' +
    '"offset" is an optional additive phase or position offset (default 0). ' +
    'For gears/belts between physics-engine joints (add_body_joint, simulate_motion) with inertia and load use add_gear_coupling instead. Cyclic couplings (A→B→A) are rejected with an explanatory summary. Returns the new drive relation id in affected[0].',
  params: z.object({
    driver: z.string().describe('Id of the driving joint (source of motion). Must exist in doc.joints.'),
    driven: z.string().describe('Id of the driven joint (receives motion). Must exist in doc.joints.'),
    ratio: z
      .number()
      .describe(
        'Coupling ratio: driven = driver * ratio + offset. ' +
          'Use 1.0 for a direct coupling, 2.0 for a 2:1 gear-up, -1.0 to reverse direction.',
      ),
    offset: z.number().optional().describe('Optional additive offset applied after ratio multiplication. Default: 0.'),
    id: z
      .string()
      .optional()
      .describe(
        'Optional explicit drive relation id. When omitted a unique id is generated. ' +
          'If the id already exists in doc.driveRelations the command is a no-op.',
      ),
  }),
  run: (doc, { driver, driven, ratio, offset, id }): CommandResult => {
    if (!(driver in doc.joints)) return noop(doc, `add_drive_relation: driver joint '${String(driver)}' does not exist in doc.joints.`);
    if (!(driven in doc.joints)) return noop(doc, `add_drive_relation: driven joint '${String(driven)}' does not exist in doc.joints.`);
    if (driver === driven) return noop(doc, `add_drive_relation: driver and driven cannot be the same joint ('${driver}').`);
    const cyclePath = detectCycleOnAdd(doc.driveRelations, driver, driven);
    if (cyclePath !== null)
      return noop(doc, `add_drive_relation: adding this relation would create a cycle: ${cyclePath}. No change made.`);
    const drId = idOrNext(id, 'dr');
    if (idTaken(doc.driveRelations, drId))
      return noop(doc, `add_drive_relation: drive relation id '${drId}' already exists — no change made.`);
    const newDr: DriveRelation = { id: drId, driver, driven, ratio, ...(offset !== undefined ? { offset } : {}) };
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
  params: z.object({ id: z.string().describe('Id of the drive relation to remove. Must match an existing entry in doc.driveRelations.') }),
  run: (doc, { id }): CommandResult => {
    const dr = Object.hasOwn(doc.driveRelations, id) ? doc.driveRelations[id] : undefined;
    if (!dr) return noop(doc, `delete_drive_relation: drive relation '${String(id)}' does not exist — no change made.`);
    const driveRelations = Object.fromEntries(Object.entries(doc.driveRelations).filter(([key]) => key !== id));
    const newDoc: CadDocument = { ...doc, driveRelations, driveRelationOrder: doc.driveRelationOrder.filter((drid) => drid !== id) };
    return report(newDoc, `delete_drive_relation: removed coupling '${dr.driver}' → '${dr.driven}' (id: '${id}').`);
  },
});

/**
 * @affects apply=false: nothing (read-only, affected:[]); apply=true: position and rotation of the moved instance entities in doc.entities
 * @invariant joint values and drive relations are unchanged; resolved joint values propagated in topo order; only instance transforms change
 * @failure no joints → empty data (apply=false) or no-op (apply=true); apply=true with a loop that cannot close → refused no-op
 */
export const evaluateMotion = defineCommand({
  name: 'evaluate_motion',
  description:
    'Compute the result of applying all kinematic joints (add_joint, set_joint_value) and drive relations (add_drive_relation) between component instances. ' +
    'Use this for poses without forces; use add_body_joint + simulate_motion for rigid-body physics (masses, forces, time). ' +
    'Drive relations are walked in topological order: driven_value = driver_value * ratio + offset. ' +
    "Then each joint is applied: revolute rotates instance b around instance a's origin along the axis; " +
    "prismatic translates instance b along the axis from instance a's origin. " +
    'Closed loops with passive joints are solved first (Levenberg-Marquardt). ' +
    'apply=false (default) is a read-only query: the document is returned unchanged with affected:[]. ' +
    'apply=true WRITES the resulting position and rotation into the affected instances (undoable; affected[] lists the moved instance ids) ' +
    'and refuses with the document unchanged when the loop cannot close (e.g. a four-bar past its Grashof limit). ' +
    'Returns data: { resolvedJoints: Record<jointId, number>, ' +
    '  resolvedValues: Record<jointId, number[]> (all DOFs),   instancePositions: Record<instanceId, Vec3>,   instanceRotations: Record<instanceId, Vec3>,   ' +
    '  loop?: { closed, residual, message, loops, passive } when joints form a closed loop (passive joints are solved; closed=false means it cannot close) }.',
  params: z.object({
    apply: z
      .boolean()
      .optional()
      .describe(
        'false (default): only compute and report, the document is unchanged. true: write the computed position/rotation into the instances.',
      ),
  }),
  run: (doc, { apply = false }): CommandResult => {
    const command = 'evaluate_motion';
    if (Object.keys(doc.joints).length === 0)
      return apply
        ? noop(doc, `${command}: no joints defined. Nothing to apply.`)
        : report(doc, `${command}: no joints defined. Nothing to evaluate.`, {
            resolvedJoints: {},
            instancePositions: {},
            instanceRotations: {},
          });
    const motion = evaluateMotionInternal(doc);
    const { resolvedJoints, instancePositions, instanceRotations, loop } = motion;
    const movedIds = Object.keys(instancePositions);
    if (!apply) {
      const loopNote = loop === undefined ? '' : ` Loop: ${loop.message}.`;
      return report(
        doc,
        `${command}: evaluated ${Object.keys(resolvedJoints).length} joint(s), ${movedIds.length} instance(s) would move.${loopNote}`,
        motion,
      );
    }
    if (loop !== undefined && !loop.closed && Object.keys(loop.passive).length > 0)
      return noop(doc, `${command}: refused — ${loop.message}. Drive value(s) or limits must change; the document is unchanged.`);
    if (movedIds.length === 0)
      return report(doc, `${command}: joints exist but no instance positions changed (all instanceIds may be missing).`);
    const newEntities = { ...doc.entities };
    for (const instanceId of movedIds) {
      const existing = newEntities[instanceId];
      const position = instancePositions[instanceId];
      if (!existing || !position) continue;
      newEntities[instanceId] = { ...existing, position, rotation: instanceRotations[instanceId] ?? existing.rotation };
    }
    return changed(
      { ...doc, entities: newEntities },
      `${command}: applied ${Object.keys(resolvedJoints).length} joint(s); updated position/rotation of ${movedIds.length} instance(s): ${movedIds.join(', ')}.`,
      movedIds,
    );
  },
});
