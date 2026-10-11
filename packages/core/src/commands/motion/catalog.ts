/** Animation clips, joints, drive relations and motion studies. */

import { commandCatalog } from '../schema';
import { animateSpin, animateOscillate, stopAnimation } from './animation';
import { addJoint, deleteJoint, setJointValue } from './jointsEdit';
import { addDriveRelation, deleteDriveRelation, evaluateMotion, bakeMotion } from './jointsDrive';
import { motionStudy } from './motionStudy';

export const motionCommands = commandCatalog(
  animateSpin,
  animateOscillate,
  stopAnimation,
  addJoint,
  deleteJoint,
  setJointValue,
  addDriveRelation,
  deleteDriveRelation,
  evaluateMotion,
  bakeMotion,
  motionStudy,
);
