/** Rigid-body dynamics: bodies, joints, gears, motors, propellers and the physics simulation. */

import { commandCatalog } from '../schema';
import { addRigidBody, deleteDynamicsItem, setGravity } from './bodies';
import { addBodyJoint, addGearCoupling } from './connections';
import { addMotor, addPropeller } from './drives';
import { inspectDynamics, simulateMotion } from './simulate';

export const dynamicsCommands = commandCatalog(
  addRigidBody,
  addBodyJoint,
  addGearCoupling,
  addMotor,
  addPropeller,
  setGravity,
  deleteDynamicsItem,
  inspectDynamics,
  simulateMotion,
);
