/** The safety wrapper `execute` sees around every registered command. */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, CommandResult, ExecutionContext, ParamsSchema } from './types';
import { isReservedKey } from '../lib/reservedKey';
import { formatIssues, issuePaths } from './schema';
import { derivationViolation } from './derivation';
import { pluginGuards } from '../plugins/host';
import { commandError, rejection } from './noop';
import { errorMessage } from '../lib/errorMessage';
import { similarNames } from '../lib/similarNames';

function containsNonFinite(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value) && value.some((v) => v === undefined || v === null)) return true;
  return Object.values(value).some((v) => containsNonFinite(v, depth + 1));
}

/** A top-level 2-number `position` is a planar shorthand: pad z=0 (never mutates `params`). */
function padPlanarPosition(params: object): object {
  const position = (params as { position?: unknown }).position;
  const isPlanar = Array.isArray(position) && position.length === 2 && position.every((n) => typeof n === 'number');
  return isPlanar ? { ...params, position: [...position, 0] } : params;
}

/** Every entity carries a Vec3 `position`; a short/odd vector would poison downstream math. */
function hasMalformedPosition(entity: unknown): boolean {
  if (typeof entity !== 'object' || entity === null) return false;
  const position = (entity as { position?: unknown }).position;
  return position !== undefined && (!Array.isArray(position) || position.length !== 3);
}

/** Param keys whose string values are looked up as keys in document records (ids). */
const ID_LIKE_KEY = /^id$|Ids?$|^ids$/;

/**
 * True when an id-like param value is an Object.prototype key (`constructor`, `__proto__`, ...), which would alias plain-object entity-bag
 * lookups. Free text (names, content) is never scanned.
 */
function hasPrototypeIdKey(value: unknown, keyHint = '', depth = 0): boolean {
  if (typeof value === 'string') return ID_LIKE_KEY.test(keyHint) && isReservedKey(value);
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasPrototypeIdKey(v, keyHint, depth + 1));
  return Object.entries(value).some(([k, v]) => hasPrototypeIdKey(v, k, depth + 1));
}

const invalidParamsFix = (command: string, paths: readonly string[]): string =>
  'Fix the params at ' +
  paths.map((path) => '`' + path + '`').join(', ') +
  '; the schema of the command: `llull describe ' +
  command +
  '`.';

const POSITION_CONTRACT = ' Format [x, y, z]; [x, y] is accepted and placed at z=0.';

/** Append the position contract so the agent-visible schema matches `padPlanarPosition`. */
function describePositionContract(schema: ParamsSchema): ParamsSchema {
  const position = schema.properties['position'];
  if (!position || position.type !== 'array') return schema;
  return {
    ...schema,
    properties: { ...schema.properties, position: { ...position, description: position.description + POSITION_CONTRACT } },
  };
}

const MAX_KNOWN_LISTED = 14;

/** Rejection for top-level keys the command does not declare (a typo would otherwise be silently dropped); null when every key is known. */
function unknownParamsRejection(def: CommandDefinition<unknown>, doc: CadDocument, params: object): CommandResult | null {
  if (def.annotations?.metadataKeys) return null;
  const known = Object.keys(def.paramsSchema.properties);
  const unknown = Object.keys(params).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  const described = unknown.map((key) => {
    const [closest] = similarNames(key, known, 1);
    return closest === undefined ? `'${key}'` : `'${key}' — did you mean '${closest}'?`;
  });
  const listed = known.slice(0, MAX_KNOWN_LISTED).join(', ') + (known.length > MAX_KNOWN_LISTED ? ', …' : '');
  return rejection(
    doc,
    `${def.name} rejected: unknown param ${described.join('; unknown param ')} (known: ${known.length > 0 ? listed : 'none'}). Document unchanged.`,
    commandError('CMD_UNKNOWN_PARAM', invalidParamsFix(def.name, unknown), [], unknown),
  );
}

/** Log `message` with the error's stack and return its message for the agent-facing summary. */
function warnAndDescribe(message: string, error: unknown): string {
  console.warn(`[llull] ${message}`, error instanceof Error ? (error.stack ?? error.message) : error);
  return errorMessage(error);
}

export function corruptionReason(entity: unknown): string | null {
  if (containsNonFinite(entity)) return 'non-finite numbers (NaN/Infinity/undefined components)';
  if (hasMalformedPosition(entity)) return 'a malformed position (must be a 3-number [x, y, z])';
  return null;
}

/**
 * @failure params fail `paramsValidator` (zod schema) -> no-op naming the failing path
 * @failure run throws (warned with stack), id-like params equal an Object.prototype key
 * (would alias entity-bag lookups), or affected entities contain NaN/Infinity/undefined vector
 * components or a non-Vec3 position -> no-op, affected:[]
 * @failure a top-level param key the schema does not declare -> rejected: unknown param 'k' (closest declared key suggested), CMD_UNKNOWN_PARAM (unless annotations.metadataKeys: tolerated, stripped)
 * @invariant non-object params are coerced to {} so field destructuring cannot throw;
 * a 2-number `position` is padded to [x, y, 0]; free-text params are never rejected
 */
export function guardCommand(def: CommandDefinition<unknown>): CommandDefinition<unknown> {
  return {
    ...def,
    paramsSchema: describePositionContract(def.paramsSchema),
    run: (doc, params, ctx): CommandResult => checkedRun(def, doc, params, ctx),
  };
}

/** Validation + run + result checks of one guarded call (see `guardCommand`). */
function checkedRun(def: CommandDefinition<unknown>, doc: CadDocument, params: unknown, ctx: ExecutionContext | undefined): CommandResult {
  const safeParams = padPlanarPosition(typeof params === 'object' && params !== null ? params : {});
  if (hasPrototypeIdKey(safeParams))
    return rejection(
      doc,
      `${def.name} rejected: an id param is a reserved JavaScript property name (e.g. constructor, __proto__, toString). Use a different id.`,
      commandError('CMD_RESERVED_ID', 'Use an id that is not a JavaScript property name (constructor, __proto__, toString, …).'),
    );
  const unknownKeys = unknownParamsRejection(def, doc, safeParams);
  if (unknownKeys !== null) return unknownKeys;
  if (def.paramsValidator) {
    let checked: ReturnType<typeof def.paramsValidator.safeParse>;
    try {
      checked = def.paramsValidator.safeParse(safeParams, { reportInput: true });
    } catch (error) {
      const reason = warnAndDescribe(`command '${def.name}' params validation threw:`, error);
      return rejection(
        doc,
        `${def.name} rejected: invalid params — ${reason}`,
        commandError('CMD_INVALID_PARAMS', invalidParamsFix(def.name, ['(params)'])),
      );
    }
    if (!checked.success)
      return rejection(
        doc,
        `${def.name} rejected: invalid params — ${formatIssues(checked.error)}. Document unchanged.`,
        commandError('CMD_INVALID_PARAMS', invalidParamsFix(def.name, issuePaths(checked.error)), [], issuePaths(checked.error)),
      );
  }
  let result: CommandResult;
  try {
    result = def.run(doc, safeParams, ctx);
  } catch (error) {
    const reason = warnAndDescribe(`command '${def.name}' threw:`, error);
    return rejection(
      doc,
      `${def.name} failed: ${reason}; document unchanged.`,
      commandError('CMD_THREW', 'An internal error; simplify the input or report the summary as a bug.'),
    );
  }
  const violation = derivationViolation(pluginGuards(), def.name, doc, result.document);
  if (violation !== null)
    return rejection(
      doc,
      violation.summary,
      violation.error ??
        commandError('CMD_DERIVED_GEOMETRY', 'Edit the domain object that derives this geometry instead of the derived entities.'),
    );
  if (result.document !== doc) {
    for (const id of result.affected) {
      const reason = corruptionReason(result.document.entities[id]);
      if (reason !== null)
        return rejection(
          doc,
          `${def.name} rejected: result for ${id} contains ${reason}. Document unchanged.`,
          commandError('CMD_CORRUPT_RESULT', 'Check the numeric params (sizes, positions) for extreme or degenerate values.', [id]),
        );
    }
  }
  return result;
}
