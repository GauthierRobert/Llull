/** Animation clips, joints, drive relations and motion studies. */

import { commandCatalog } from '../schema';
import { animate, stopAnimation } from './animation';
import { addJoint } from './addJoint';
import { deleteJoint, setJointValue } from './jointsEdit';
import { createContactSet, deleteContactSet } from './contactSets';
import { driveJointTo } from './driveJoint';
import { addDriveRelation, deleteDriveRelation, evaluateMotion } from './jointsDrive';
import { motionStudy } from './motionStudy';

export const motionCommands = commandCatalog(
  animate,
  stopAnimation,
  addJoint,
  deleteJoint,
  setJointValue,
  addDriveRelation,
  deleteDriveRelation,
  evaluateMotion,
  motionStudy,
  createContactSet,
  deleteContactSet,
  driveJointTo,
);
