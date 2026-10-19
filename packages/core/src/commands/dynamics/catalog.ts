/** Rigid-body dynamics: bodies, joints, gears, motors, propellers and the physics simulation. */

import { commandCatalog } from '../schema';
import { addRigidBody, deleteDynamicsItem, setGravity } from './bodies';
import { addBodyJoint, addGearCoupling } from './connections';
import { checkDynamics } from './checkDynamics';
import { checkMotionClearance } from './checkMotionClearance';
import { addCylinderPressure } from './cylinders';
import { setEngineLosses } from './engine/losses';
import { addReferenceData } from './engine/reference';
import { compareToReference } from './engine/compareReference';
import { checkTimestepConvergence } from './engine/timestepConvergence';
import { addMotor, addPropeller } from './drives';
import { inspectDynamics } from './inspect';
import { plotSimulation } from './plot';
import { renderMotion } from './renderMotion';
import { engineQuickCheck } from './quickCheck';
import { simulateMotion } from './simulate';
import { addSpring } from './springs';
import { setDynamicsSolver } from './solver';
import { installEngineLaws } from './engine/hooks';

// the catalog is the composition point of the engine folder (spec 11 Q3): generic dynamics reads the laws through injection points only
installEngineLaws();

export const dynamicsCommands = commandCatalog(
  addRigidBody,
  addBodyJoint,
  addGearCoupling,
  addSpring,
  addMotor,
  addPropeller,
  addCylinderPressure,
  setEngineLosses,
  addReferenceData,
  setGravity,
  deleteDynamicsItem,
  setDynamicsSolver,
  inspectDynamics,
  engineQuickCheck,
  compareToReference,
  checkTimestepConvergence,
  simulateMotion,
  checkDynamics,
  checkMotionClearance,
  plotSimulation,
  renderMotion,
);
