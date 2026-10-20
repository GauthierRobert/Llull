/** Access to and validation of the explicit set-up stored on analysis cases (`AnalysisCase.explicit`, plugin `explicit`). */

import type { AnalysisCase } from '@core/model/analysis';
import type { ExplicitSpec } from '@core/model/explicit';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { caseOf, withCase } from '../shared/access';

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
  if (analysisCase.unitSystem === 'N-mm-t-s') return { length: 'mm', stress: 'MPa', energy: 'mJ', force: 'N' };
  if (analysisCase.unitSystem === 'N-m-kg-s') return { length: 'm', stress: 'Pa', energy: 'J', force: 'N' };
  return null;
}

const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isNamed = (value: unknown): boolean => isRecord(value) && finite(value['value']) && typeof value['source'] === 'string';
const isVec = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(finite);

function specErrors(caseId: string, spec: unknown): string[] {
  const where = `analysis.cases.${caseId}.explicit`;
  if (!isRecord(spec)) return [`${where} is malformed`];
  const errors: string[] = [];
  const endTime = spec['endTimeS'];
  const history = spec['historyIntervalS'];
  if (
    !finite(endTime) ||
    !finite(history) ||
    !((endTime as number) > 0) ||
    !((history as number) > 0) ||
    (history as number) > (endTime as number)
  )
    errors.push(`${where}: endTimeS / historyIntervalS must satisfy 0 < historyIntervalS <= endTimeS`);
  const bulk = spec['bulkViscosity'];
  if (
    !isNamed(spec['timeStepScale']) ||
    !isNamed(spec['hourglassCoefficient']) ||
    !isRecord(bulk) ||
    !isNamed(bulk['linear']) ||
    !isNamed(bulk['quadratic'])
  )
    errors.push(`${where}: named settings are malformed`);
  const mesh = spec['mesh'];
  if (
    !isRecord(mesh) ||
    (mesh['kind'] !== 'fea_mesh' && !(mesh['kind'] === 'structured_hex' && finite(mesh['size']) && (mesh['size'] as number) > 0))
  )
    errors.push(`${where}.mesh is malformed`);
  const scaling = spec['massScaling'];
  if (
    !isRecord(scaling) ||
    (scaling['mode'] !== 'none' &&
      !(scaling['mode'] === 'selective' && finite(scaling['targetTimeStepS']) && finite(scaling['maxAddedMassRatio'])))
  )
    errors.push(`${where}.massScaling is malformed`);
  if (spec['gravity'] !== undefined && !isVec(spec['gravity'])) errors.push(`${where}.gravity must be [x, y, z]`);
  const velocities = spec['initialVelocities'];
  if (
    !isRecord(velocities) ||
    !Object.values(velocities).every((entry) => isRecord(entry) && typeof entry['entityId'] === 'string' && isVec(entry['velocity']))
  )
    errors.push(`${where}.initialVelocities is malformed`);
  const walls = spec['rigidWalls'];
  const order = spec['rigidWallOrder'];
  if (
    !isRecord(walls) ||
    !Array.isArray(order) ||
    order.some((id) => typeof id !== 'string' || !Object.hasOwn(walls, id)) ||
    !Object.values(walls).every(
      (wall) => isRecord(wall) && typeof wall['name'] === 'string' && isVec(wall['point']) && isVec(wall['normal']),
    )
  )
    errors.push(`${where}.rigidWalls / rigidWallOrder are malformed`);
  const contacts = spec['contacts'];
  const contactOrder = spec['contactOrder'];
  if (
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
  )
    errors.push(`${where}.contacts / contactOrder are malformed`);
  const shells = spec['shells'];
  if (shells !== undefined && (!isRecord(shells) || !Object.values(shells).every((entry) => isRecord(entry) && finite(entry['points']))))
    errors.push(`${where}.shells is malformed`);
  const failure = spec['failure'];
  if (
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
  )
    errors.push(`${where}.failure is malformed`);
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
