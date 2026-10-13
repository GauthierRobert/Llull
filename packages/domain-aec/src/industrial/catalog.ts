/**
 * Industrial-steel commands — portal frames, members, checks, fabrication — the `industrial`
 * plugin's catalog (see plugin.ts).
 */

import { commandCatalog } from '@core/commands/schema';
import { listSteelProfiles } from '../steel/steelProfileList';
import { addSteelMember, updateSteelMember } from './framing/memberSteelCommands';
import { addGridBeams, addGridBracing, addGridColumns } from './framing/gridFramingCommands';
import { addEquipmentOpenings } from './equipment/equipmentOpenings';
import { addFooting, addPanel } from './framing/memberFootingPanelCommands';
import { addEquipment, addPipeRun } from './equipment/equipment';
import { updateEquipment } from './equipment/equipmentUpdate';
import { addCraneRunway, addPortalFrameBuilding } from './portal/portal';
import { checkClashes } from './clash/clash';
import { addCableTray } from './piping/trays';
import { addBasePlates } from './connections/plates';
import { addMomentConnections } from './connections/connections';
import { checkPortalFrames } from './frames/frameCheckPortal';
import { designPortalFrames } from './frames/frameDesign';
import { checkBracing } from './bracing/bracingCheckRun';
import { foundationCheck } from './foundations/foundationCheckRun';
import { designFootings } from './foundations/footingDesignCommand';
import { exportNcFiles } from './fabrication/ncExport';
import { checkPurlins } from './purlins/purlinCheckRun';
import { designPurlins } from './purlins/purlinDesign';
import { exportAnchorPlan } from './anchorPlan/anchorPlanExport';
import { runwayCheck } from './runway/runwayCheckRun';
import { checkSteelMembers } from './steelDesign/steelMembersCheck';
import { addPipeSupport } from './piping/pipeSupports';
import { checkPipeSupports } from './piping/pipeSupportCheck';

/** Industrial-steel commands (portal frames, members, checks, fabrication). */
export const industrialCommands = commandCatalog(
  listSteelProfiles,
  addSteelMember,
  updateSteelMember,
  addGridColumns,
  addGridBeams,
  addGridBracing,
  addFooting,
  addPanel,
  addEquipment,
  updateEquipment,
  addEquipmentOpenings,
  addPipeRun,
  addPipeSupport,
  addCableTray,
  addBasePlates,
  addMomentConnections,
  checkPortalFrames,
  designPortalFrames,
  checkBracing,
  foundationCheck,
  designFootings,
  exportNcFiles,
  checkPurlins,
  designPurlins,
  exportAnchorPlan,
  runwayCheck,
  checkSteelMembers,
  checkPipeSupports,
  addCraneRunway,
  addPortalFrameBuilding,
  checkClashes,
);
