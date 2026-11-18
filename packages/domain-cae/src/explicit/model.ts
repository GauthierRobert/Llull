/** Access to and validation of the explicit set-up stored on analysis cases (`AnalysisCase.explicit`, plugin `explicit`). */

import type { AnalysisCase } from '@core/model/analysis';
import { TIME_HISTORY_QUANTITIES, type ExplicitSpec, type ExplicitTimeHistoryKind } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { unitSystemFactors } from '../decks/units';
import { caseOf, withCase } from '../shared/access';
import { withinHistoryCap } from './defaults';

/** The case and its spec when `analysisId` is an explicit case, else a code + message. */
export function explicitCase(
  doc: CadDocument,
  analysisId: string,
): { readonly analysisCase: AnalysisCase; readonly spec: ExplicitSpec | undefined } | { readonly code: string; readonly message: string } {
  const analysisCase = caseOf(doc, analysisId);
  if (analysisCase === undefined) return { code: 'FEA_ANALYSIS_NOT_FOUND', message: `no analysis '${analysisId}'` };
  if (analysisCase.type !== 'explicit_dynamics')
    return { code: 'EXP_CASE_TYPE', message: `analysis '${analysisId}' is ${analysisCase.type}, not explicit_dynamics` };
  return { analysisCase, spec: analysisCase.explicit };
}

/** `doc` with the case's explicit spec replaced. */
export const withSpec = (doc: CadDocument, analysisCase: AnalysisCase, spec: ExplicitSpec): CadDocument =>
  withCase(doc, { ...analysisCase, explicit: spec });

/** Analysis length unit per metre-based unit system the solver supports, else null. */
export function supportedUnits(
  analysisCase: AnalysisCase,
): { readonly length: string; readonly stress: string; readonly energy: string; readonly force: string } | null {
  const { lengthUnit, stressUnit, energyUnit } = unitSystemFactors(analysisCase.unitSystem);
  return energyUnit === null ? null : { length: lengthUnit, stress: stressUnit, energy: energyUnit, force: 'N' };
}

const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isNamed = (value: unknown): boolean => isRecord(value) && finite(value['value']) && typeof value['source'] === 'string';
const isVec = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(finite);

/** Time-history records: shape, unique names, one of each quantity, intervals within (0, endTime] and the sample cap, walls of the case. */
function historiesValid(spec: Record<string, unknown>): boolean {
  const histories = spec['timeHistories'];
  const order = spec['timeHistoryOrder'];
  const endTime = spec['endTimeS'];
  const walls = spec['rigidWallOrder'];
  if (!isRecord(histories) || !Array.isArray(order) || order.length > 32) return false;
  if (order.some((id) => typeof id !== 'string' || !Object.hasOwn(histories, id))) return false;
  const entries = Object.values(histories);
  if (new Set(entries.map((entry) => (isRecord(entry) ? entry['name'] : entry))).size !== entries.length) return false;
  return entries.every((entry) => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || !Array.isArray(entry['quantities'])) return false;
    const kind = String(entry['kind']);
    if (!Object.hasOwn(TIME_HISTORY_QUANTITIES, kind)) return false;
    const allowed: readonly unknown[] = TIME_HISTORY_QUANTITIES[kind as ExplicitTimeHistoryKind];
    const quantities: readonly unknown[] = entry['quantities'];
    const interval = entry['intervalS'];
    const target = entry['target'];
    const intervalOk =
      interval === undefined ||
      (finite(interval) &&
        (interval as number) > 0 &&
        finite(endTime) &&
        (interval as number) <= (endTime as number) &&
        withinHistoryCap(endTime as number, interval as number));
    return (
      quantities.length > 0 &&
      new Set(quantities).size === quantities.length &&
      quantities.every((quantity) => allowed.includes(quantity)) &&
      intervalOk &&
      (kind === 'rigid_wall'
        ? typeof entry['wallId'] === 'string' && Array.isArray(walls) && walls.includes(entry['wallId'])
        : isRecord(target) && typeof target['entityId'] === 'string')
    );
  });
}

type Spec = Record<string, unknown>;

const timingMalformed = (spec: Spec): boolean => {
  const endTime = spec['endTimeS'];
  const history = spec['historyIntervalS'];
  return (
    !finite(endTime) ||
    !finite(history) ||
    !((endTime as number) > 0) ||
    !((history as number) > 0) ||
    (history as number) > (endTime as number) ||
    !withinHistoryCap(endTime as number, history as number)
  );
};

const namedSettingsMalformed = (spec: Spec): boolean => {
  const bulk = spec['bulkViscosity'];
  return (
    !isNamed(spec['timeStepScale']) ||
    !isNamed(spec['hourglassCoefficient']) ||
    !isRecord(bulk) ||
    !isNamed(bulk['linear']) ||
    !isNamed(bulk['quadratic'])
  );
};

const meshMalformed = (spec: Spec): boolean => {
  const mesh = spec['mesh'];
  return (
    !isRecord(mesh) ||
    (mesh['kind'] !== 'fea_mesh' && !(mesh['kind'] === 'structured_hex' && finite(mesh['size']) && (mesh['size'] as number) > 0))
  );
};

const massScalingMalformed = (spec: Spec): boolean => {
  const scaling = spec['massScaling'];
  return (
    !isRecord(scaling) ||
    (scaling['mode'] !== 'none' &&
      !(scaling['mode'] === 'selective' && finite(scaling['targetTimeStepS']) && finite(scaling['maxAddedMassRatio'])))
  );
};

const velocitiesMalformed = (spec: Spec): boolean => {
  const velocities = spec['initialVelocities'];
  return (
    !isRecord(velocities) ||
    !Object.values(velocities).every((entry) => isRecord(entry) && typeof entry['entityId'] === 'string' && isVec(entry['velocity']))
  );
};

const wallsMalformed = (spec: Spec): boolean => {
  const walls = spec['rigidWalls'];
  const order = spec['rigidWallOrder'];
  return (
    !isRecord(walls) ||
    !Array.isArray(order) ||
    order.some((id) => typeof id !== 'string' || !Object.hasOwn(walls, id)) ||
    !Object.values(walls).every(
      (wall) => isRecord(wall) && typeof wall['name'] === 'string' && isVec(wall['point']) && isVec(wall['normal']),
    )
  );
};

const contactsMalformed = (spec: Spec): boolean => {
  const contacts = spec['contacts'];
  const contactOrder = spec['contactOrder'];
  return (
    contacts !== undefined &&
    (!isRecord(contacts) ||
      !Array.isArray(contactOrder) ||
      contactOrder.some((id) => typeof id !== 'string' || !Object.hasOwn(contacts, id)) ||
      !Object.values(contacts).every(
        (entry) =>
          isRecord(entry) &&
          typeof entry['name'] === 'string' &&
          Array.isArray(entry['a']) &&
          Array.isArray(entry['b']) &&
          isNamed(entry['penaltyScale']),
      ))
  );
};

const shellsMalformed = (spec: Spec): boolean => {
  const shells = spec['shells'];
  return shells !== undefined && (!isRecord(shells) || !Object.values(shells).every((entry) => isRecord(entry) && finite(entry['points'])));
};

const failureMalformed = (spec: Spec): boolean => {
  const failure = spec['failure'];
  return (
    failure !== undefined &&
    (!isRecord(failure) ||
      !Object.values(failure).every(
        (entry) =>
          isRecord(entry) &&
          Array.isArray(entry['D']) &&
          entry['D'].length === 5 &&
          entry['D'].every(finite) &&
          typeof entry['source'] === 'string',
      ))
  );
};

const motionsMalformed = (spec: Spec): boolean => {
  const motions = spec['imposedMotions'];
  const motionOrder = spec['imposedMotionOrder'];
  return (
    motions !== undefined &&
    (!isRecord(motions) ||
      !Array.isArray(motionOrder) ||
      motionOrder.some((id) => typeof id !== 'string' || !Object.hasOwn(motions, id)) ||
      !Object.values(motions).every(
        (entry) =>
          isRecord(entry) &&
          typeof entry['name'] === 'string' &&
          isRecord(entry['target']) &&
          typeof entry['target']['entityId'] === 'string' &&
          ['x', 'y', 'z'].includes(String(entry['dof'])) &&
          ['velocity', 'displacement'].includes(String(entry['kind'])) &&
          Array.isArray(entry['curve']) &&
          entry['curve'].every((point) => Array.isArray(point) && point.length === 2 && point.every(finite)),
      ))
  );
};

const heatingMalformed = (spec: Spec): boolean => {
  const heating = spec['heating'];
  return (
    heating !== undefined &&
    (!isRecord(heating) || !Object.values(heating).every((entry) => isRecord(entry) && isNamed(entry['taylorQuinney'])))
  );
};

function specErrors(caseId: string, spec: unknown): string[] {
  const where = `analysis.cases.${caseId}.explicit`;
  if (!isRecord(spec)) return [`${where} is malformed`];
  const errors: string[] = [];
  if (timingMalformed(spec)) errors.push(`${where}: endTimeS / historyIntervalS must satisfy 0 < historyIntervalS <= endTimeS`);
  if (namedSettingsMalformed(spec)) errors.push(`${where}: named settings are malformed`);
  if (meshMalformed(spec)) errors.push(`${where}.mesh is malformed`);
  if (massScalingMalformed(spec)) errors.push(`${where}.massScaling is malformed`);
  if (spec['gravity'] !== undefined && !isVec(spec['gravity'])) errors.push(`${where}.gravity must be [x, y, z]`);
  if (velocitiesMalformed(spec)) errors.push(`${where}.initialVelocities is malformed`);
  if (wallsMalformed(spec)) errors.push(`${where}.rigidWalls / rigidWallOrder are malformed`);
  if (contactsMalformed(spec)) errors.push(`${where}.contacts / contactOrder are malformed`);
  if (shellsMalformed(spec)) errors.push(`${where}.shells is malformed`);
  if (failureMalformed(spec)) errors.push(`${where}.failure is malformed`);
  if (motionsMalformed(spec)) errors.push(`${where}.imposedMotions / imposedMotionOrder are malformed`);
  if (spec['timeHistories'] !== undefined && !historiesValid(spec)) errors.push(`${where}.timeHistories / timeHistoryOrder are malformed`);
  if (heatingMalformed(spec)) errors.push(`${where}.heating is malformed`);
  return errors;
}

/** Value errors of the raw `analysis` slice's explicit set-ups (persistence rejects the file when non-empty). */
export function explicitErrors(raw: Record<string, unknown>): string[] {
  const analysis = raw['analysis'];
  if (!isRecord(analysis) || !isRecord(analysis['cases'])) return [];
  return Object.entries(analysis['cases']).flatMap(([caseId, analysisCase]) =>
    isRecord(analysisCase) && analysisCase['explicit'] !== undefined ? specErrors(caseId, analysisCase['explicit']) : [],
  );
}
