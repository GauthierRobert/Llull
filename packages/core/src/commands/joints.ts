/**
 * @command add_joint
 * @command delete_joint
 * @command set_joint_value
 * @command add_drive_relation
 * @command delete_drive_relation
 * @command evaluate_motion
 * @command bake_motion
 * @pure
 * @layer core/commands
 * @affects add_joint: appends to doc.joints and doc.jointOrder
 *          delete_joint: removes from doc.joints/doc.jointOrder; cascade-removes dependent DriveRelations
 *          set_joint_value: updates angle or displacement on an existing joint
 *          add_drive_relation: appends to doc.driveRelations and doc.driveRelationOrder
 *          delete_drive_relation: removes from doc.driveRelations/doc.driveRelationOrder
 *          evaluate_motion: no-op (query) — returns resolved joint values + instance transforms in data
 *          bake_motion: updates instance positions/rotations based on evaluated joint values
 * @invariant Joint ids are unique; JointMateRef.instanceId must be an InstanceEntity in doc.entities
 * @invariant DriveRelation graph is acyclic (Kahn topo-sort enforced on add_drive_relation)
 * @failure unknown joint id / unknown instanceId → no-op, affected:[]
 *          self-coupling / cycle in drive graph → no-op, affected:[]
 *          evaluate_motion with no joints → empty data, friendly summary
 */

export { addJoint, deleteJoint, setJointValue } from './jointsEdit';
export { addDriveRelation, deleteDriveRelation, evaluateMotion, bakeMotion } from './jointsDrive';
