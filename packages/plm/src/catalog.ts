/** PLM commands (09 PLM §4), toolset `plm`. */

import { commandCatalog } from '@core/commands/schema';
import { classifyChangeOrder, createChangeOrder, createChangeRequest, setChangeState } from './commands/change';
import { setItemIdentity, setRevisionScheme } from './commands/identity';
import { setItemMarking } from './commands/marking';
import { releaseItem, reviseItem, setLifecycleState } from './commands/release';
import { checkpointIteration, recordApproval, rejectReview, submitForReview } from './commands/review';
import { attachReleasePackage, recordSignature } from './commands/signature';
import { checkReleaseReadiness, plmStatus, releaseManifestQuery, resolveEffectivity, viewRevision } from './commands/status';
import { plmDiff, restoreRevisionSnapshot, verifyRelease } from './commands/verify';

export const plmCommands = commandCatalog(
  setItemIdentity,
  setRevisionScheme,
  setItemMarking,
  checkpointIteration,
  submitForReview,
  rejectReview,
  recordApproval,
  releaseItem,
  reviseItem,
  setLifecycleState,
  createChangeRequest,
  createChangeOrder,
  classifyChangeOrder,
  setChangeState,
  recordSignature,
  attachReleasePackage,
  plmStatus,
  checkReleaseReadiness,
  resolveEffectivity,
  releaseManifestQuery,
  viewRevision,
  plmDiff,
  verifyRelease,
  restoreRevisionSnapshot,
);
