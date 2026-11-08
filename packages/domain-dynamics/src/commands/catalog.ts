/** Rigid-body dynamics: bodies, joints, transmissions, joint physics, motors, propellers, flight loads (rotors, body drag) and the physics simulation. */

import { commandCatalog } from '@core/commands/schema';
import { addRigidBody, deleteDynamicsItem, setGravity } from './bodies';
import { addBodyJoint } from './connections';
import { addTransmission } from './transmissions';
import { setJointPhysics } from './jointPhysics';
import { addLoadSchedule } from './loadSchedules';
import { checkDynamics } from './checkDynamics';
import { checkMotionClearance } from './checkMotionClearance';
import { checkPrototype } from './checkPrototype';
import { addCylinderPressure } from './cylinders';
import { setEngineLosses } from './engine/losses';
import { addReferenceData } from './engine/reference';
import { compareToReference } from './engine/compareReference';
import { checkTimestepConvergence } from './engine/timestepConvergence';
import { addMotor, addPropeller } from './drives';
import { addRotor, setBodyDrag } from './flight';
import { checkMotorDataCommand } from './motorData';
import { setMotorDrive } from './motorDrive';
import { inspectDynamics } from './inspect';
import { listDynamicsLoads } from './loads';
import { plotSimulation } from './plot';
import { engineQuickCheck } from './quickCheck';
import { simulateMotion } from './simulate';
import { sizeDrive } from './sizeDrive';
import { fitDriveParameters } from './fitDrive';
import { checkMotionTruth } from './motionTruth';
import { addSpring } from './springs';
import { setDynamicsSolver } from './solver';
import { installEngineLaws } from './engine/hooks';

// the catalog is the composition point of the engine folder (spec 11 Q3): generic dynamics reads the laws through injection points only
installEngineLaws();

export const dynamicsCommands = commandCatalog(
  addRigidBody,
  addBodyJoint,
  addTransmission,
  setJointPhysics,
  addLoadSchedule,
  addSpring,
  addMotor,
  checkMotorDataCommand,
  setMotorDrive,
  addPropeller,
  addRotor,
  setBodyDrag,
  addCylinderPressure,
  setEngineLosses,
  addReferenceData,
  setGravity,
  deleteDynamicsItem,
  setDynamicsSolver,
  inspectDynamics,
  listDynamicsLoads,
  engineQuickCheck,
  compareToReference,
  checkTimestepConvergence,
  simulateMotion,
  sizeDrive,
  fitDriveParameters,
  checkMotionTruth,
  checkDynamics,
  checkMotionClearance,
  checkPrototype,
  plotSimulation,
);
