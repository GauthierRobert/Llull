/** Value validation of the convergence studies of a raw analysis case (load path): ids, order, levels, hashes, named values, exception. */

import { isRecord } from '@lib/isRecord';

const HASH = /^[0-9a-f]{64}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const QUANTITY_KINDS = ['probe', 'field_max', 'frequency', 'buckling_factor'];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

function namedProblem(value: unknown, where: string): string[] {
  return isRecord(value) && positive(value['value']) && text(value['source']) && typeof value['defaulted'] === 'boolean'
    ? []
    : [`${where} must be { value > 0, source, defaulted }`];
}

function quantityProblem(quantity: unknown, where: string): string[] {
  if (!isRecord(quantity) || typeof quantity['kind'] !== 'string' || !QUANTITY_KINDS.includes(quantity['kind']))
    return [`${where} has an unknown kind`];
  const { kind } = quantity;
  if (kind === 'probe')
    return text(quantity['probeId']) && (quantity['loadCase'] === undefined || text(quantity['loadCase']))
      ? []
      : [`${where} needs a probeId`];
  if (kind === 'field_max')
    return (quantity['field'] === 'von_mises' || quantity['field'] === 'u_mag') && text(quantity['loadCase'])
      ? []
      : [`${where} needs field and loadCase`];
  return Number.isInteger(quantity['mode']) && (quantity['mode'] as number) > 0 ? [] : [`${where} needs a mode >= 1`];
}

function levelProblems(level: unknown, index: number, previousH: number, where: string): string[] {
  const here = `${where}.levels[${index}]`;
  if (!isRecord(level)) return [`${here} is malformed`];
  const problems: string[] = [];
  if (level['index'] !== index) problems.push(`${here}.index must be ${index}`);
  const controls = level['controls'];
  if (
    !isRecord(controls) ||
    !positive(controls['globalSize']) ||
    (controls['order'] !== 1 && controls['order'] !== 2) ||
    !Array.isArray(controls['refinements'])
  )
    problems.push(`${here}.controls is malformed`);
  if (!Number.isInteger(level['elements']) || (level['elements'] as number) <= 0)
    problems.push(`${here}.elements must be a positive integer`);
  if (!positive(level['h']) || level['h'] <= previousH) problems.push(`${here}.h must be > 0 and larger than the finer level's`);
  if (!finite(level['value'])) problems.push(`${here}.value must be finite`);
  for (const key of ['meshHash', 'resultsHash', 'inputHash'])
    if (typeof level[key] !== 'string' || !HASH.test(level[key])) problems.push(`${here}.${key} must be a sha256 hex hash`);
  for (const key of ['solver', 'solverVersion', 'mesher', 'mesherVersion'])
    if (!text(level[key])) problems.push(`${here}.${key} must be text`);
  return problems;
}

function exceptionProblems(exception: unknown, where: string): string[] {
  if (!isRecord(exception)) return [`${where}.exception is malformed`];
  const ok =
    text(exception['code']) &&
    text(exception['justification']) &&
    text(exception['signer']) &&
    text(exception['signatureId']) &&
    isRecord(exception['signature']) &&
    Array.isArray(exception['levelHashes']) &&
    exception['levelHashes'].every((hash) => typeof hash === 'string' && HASH.test(hash)) &&
    typeof exception['documentUid'] === 'string';
  return ok ? [] : [`${where}.exception needs code, justification, signer, signatureId, signature, levelHashes and documentUid`];
}

/** Errors of one study record. */
function studyProblems(study: unknown, id: string, analysisId: string, where: string): string[] {
  if (!isRecord(study) || study['id'] !== id) return [`${where} is malformed`];
  const problems: string[] = [];
  if (study['analysisId'] !== analysisId) problems.push(`${where}.analysisId must be '${analysisId}'`);
  problems.push(...quantityProblem(study['quantity'], `${where}.quantity`));
  if (!text(study['unit'])) problems.push(`${where}.unit must be text`);
  if (study['refinement'] !== 'h') problems.push(`${where}.refinement must be 'h'`);
  if (!(finite(study['ratio']) && study['ratio'] > 1)) problems.push(`${where}.ratio must be > 1`);
  const measure = study['measure'];
  if (!isRecord(measure) || !positive(measure['value']) || ![1, 2, 3].includes(measure['dimension'] as number))
    problems.push(`${where}.measure is malformed`);
  problems.push(...namedProblem(study['safetyFactor'], `${where}.safetyFactor`));
  if (study['formalOrder'] !== undefined) problems.push(...namedProblem(study['formalOrder'], `${where}.formalOrder`));
  if (study['verified'] !== undefined && study['verified'] !== false) problems.push(`${where}.verified must be false when present`);
  const levels = study['levels'];
  if (!Array.isArray(levels) || levels.length < 3 || levels.length > 6) problems.push(`${where}.levels must hold 3 to 6 levels`);
  else {
    let previousH = 0;
    levels.forEach((level, index) => {
      problems.push(...levelProblems(level, index, previousH, where));
      if (isRecord(level) && positive(level['h'])) previousH = level['h'];
    });
  }
  if (study['exception'] !== undefined) problems.push(...exceptionProblems(study['exception'], where));
  return problems;
}

/** Errors of the `studies` / `studyOrder` of one raw analysis case (none when the case has no study). */
export function studyErrors(analysisCase: Record<string, unknown>, analysisId: string, where: string): string[] {
  const { studies, studyOrder } = analysisCase;
  if (studies === undefined && studyOrder === undefined) return [];
  if (!isRecord(studies) || !Array.isArray(studyOrder) || !studyOrder.every((id) => typeof id === 'string'))
    return [`${where}: studies must be a record with a studyOrder id list`];
  const order = studyOrder as string[];
  const problems: string[] = [];
  if (new Set(order).size !== order.length) problems.push(`${where}: duplicate ids in studyOrder`);
  for (const id of order) if (!Object.hasOwn(studies, id)) problems.push(`${where}: study '${id}' is listed but missing`);
  for (const [id, study] of Object.entries(studies)) {
    if (RESERVED.includes(id)) problems.push(`${where}: '${id}' is a reserved name`);
    if (!order.includes(id)) problems.push(`${where}: study '${id}' is missing from studyOrder`);
    problems.push(...studyProblems(study, id, analysisId, `${where}.studies['${id}']`));
  }
  return problems;
}
