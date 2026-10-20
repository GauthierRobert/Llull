/** PLM commands (09 PLM §4), toolset `plm`. */

import { commandCatalog } from '@core/commands/schema';
import { classifyChangeOrder, createChangeOrder, createChangeRequest, setChangeState } from './commands/change';
import { setItemIdentity, setRevisionScheme } from './commands/identity';
import { setItemMarking } from './commands/marking';
import { releaseItem, reviseItem, setLifecycleState } from './commands/release';
import { checkpointIteration, recordApproval, rejectReview, submitForReview } from './commands/review';
import { attachReleasePackage, recordSignature } from './commands/signature';
import { checkReleaseReadiness, plmActPayload, plmStatus, releaseManifestQuery, resolveEffectivity, viewRevision } from './commands/status';
import { plmDiff, restoreRevisionSnapshot, verifyRelease } from './commands/verify';
import { assignCharacteristicIds } from './commands/characteristics';
import { faiReportSkeleton } from './commands/fai';
import { bindComponentItem, compareBaselines, createBaseline, engineeringBom, unbindComponentItem } from './commands/structure';
import { externalizeSnapshots } from './commands/vault';
import { asBuiltVsAsDesigned, recordAsBuilt } from './commands/asBuilt';
import { createMbom, manufacturingBom } from './commands/mbom';
import { importQifResults } from './commands/qif';
import { exportStepPdm } from './commands/pdm';
import { lotarValidationProperties } from './commands/lotar';

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
  plmActPayload,
  checkReleaseReadiness,
  resolveEffectivity,
  releaseManifestQuery,
  viewRevision,
  plmDiff,
  verifyRelease,
  restoreRevisionSnapshot,
  externalizeSnapshots,
  bindComponentItem,
  unbindComponentItem,
  engineeringBom,
  createBaseline,
  compareBaselines,
  assignCharacteristicIds,
  faiReportSkeleton,
  recordAsBuilt,
  asBuiltVsAsDesigned,
  createMbom,
  manufacturingBom,
  importQifResults,
  exportStepPdm,
  lotarValidationProperties,
);
