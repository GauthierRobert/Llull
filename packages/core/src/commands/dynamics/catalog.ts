/** Rigid-body dynamics: bodies, joints, gears, motors, propellers and the physics simulation. */

import { commandCatalog } from '../schema';
import { addRigidBody, deleteDynamicsItem, setGravity } from './bodies';
import { addBodyJoint, addGearCoupling } from './connections';
import { addCylinderPressure } from './cylinders';
import { addMotor, addPropeller } from './drives';
import { inspectDynamics } from './inspect';
import { plotSimulation } from './plot';
import { engineQuickCheck } from './quickCheck';
import { simulateMotion } from './simulate';
import { setDynamicsSolver } from './solver';

export const dynamicsCommands = commandCatalog(
  addRigidBody,
  addBodyJoint,
  addGearCoupling,
  addMotor,
  addPropeller,
  addCylinderPressure,
  setGravity,
  deleteDynamicsItem,
  setDynamicsSolver,
  inspectDynamics,
  engineQuickCheck,
  simulateMotion,
  plotSimulation,
);
