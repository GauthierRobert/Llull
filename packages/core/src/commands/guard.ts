/**
 * @layer core/commands
 * The safety wrapper `execute` sees around every registered command.
 */

import type { CommandDefinition, CommandResult, ParamsSchema } from './types';
import { currentContext } from './context';
import { formatIssues } from './schema';
import { derivationViolation } from './derivation';
import { pluginGuards } from '../plugins/host';
import { noop } from './noop';

function containsNonFinite(value: unknown, depth = 0): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value) && value.some((v) => v === undefined || v === null)) return true;
  return Object.values(value).some((v) => containsNonFinite(v, depth + 1));
}

/** A top-level 2-number `position` is a planar shorthand: pad z=0 (never mutates `params`). */
function padPlanarPosition(params: object): object {
  const position = (params as { position?: unknown }).position;
  const isPlanar =
    Array.isArray(position) &&
    position.length === 2 &&
    position.every((n) => typeof n === 'number');
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
 * True when an id-like param value is an Object.prototype key (`constructor`, `__proto__`, ...),
 * which would alias plain-object entity-bag lookups. Free text (names, content) is never scanned.
 */
function hasPrototypeIdKey(value: unknown, keyHint = '', depth = 0): boolean {
  if (typeof value === 'string') return ID_LIKE_KEY.test(keyHint) && value in Object.prototype;
  if (typeof value !== 'object' || value === null || depth > 8) return false;
  if (Array.isArray(value)) return value.some((v) => hasPrototypeIdKey(v, keyHint, depth + 1));
  return Object.entries(value).some(([k, v]) => hasPrototypeIdKey(v, k, depth + 1));
}

const POSITION_CONTRACT = ' Format [x, y, z]; [x, y] is accepted and placed at z=0.';

/** Append the position contract so the agent-visible schema matches `padPlanarPosition`. */
function describePositionContract(schema: ParamsSchema): ParamsSchema {
  const position = schema.properties['position'];
  if (!position || position.type !== 'array') return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      position: { ...position, description: position.description + POSITION_CONTRACT },
    },
  };
}

function corruptionReason(entity: unknown): string | null {
  if (containsNonFinite(entity)) return 'non-finite numbers (NaN/Infinity/undefined components)';
  if (hasMalformedPosition(entity)) return 'a malformed position (must be a 3-number [x, y, z])';
  return null;
}

/**
 * @pure
 * @failure params fail `paramsValidator` (zod schema) -> no-op naming the failing path
 * @failure run throws (warned with stack), id-like params equal an Object.prototype key
 * (would alias entity-bag lookups), or affected entities contain NaN/Infinity/undefined vector
 * components or a non-Vec3 position -> no-op, affected:[]
 * @invariant non-object params are coerced to {} so field destructuring cannot throw;
 * a 2-number `position` is padded to [x, y, 0]; free-text params are never rejected
 */
export function guardCommand(def: CommandDefinition<unknown>): CommandDefinition<unknown> {
  return {
    ...def,
    paramsSchema: describePositionContract(def.paramsSchema),
    run: (doc, params, ctx): CommandResult => {
      const safeParams = padPlanarPosition(
        typeof params === 'object' && params !== null ? params : {},
      );
      if (hasPrototypeIdKey(safeParams)) {
        return noop(
          doc,
          `${def.name} rejected: an id param is a reserved JavaScript property name (e.g. constructor, __proto__, toString). Use a different id.`,
        );
      }
      if (def.paramsValidator) {
        let checked: ReturnType<typeof def.paramsValidator.safeParse>;
        try {
          checked = def.paramsValidator.safeParse(safeParams, { reportInput: true });
        } catch (error) {
          console.warn(
            `[llull] command '${def.name}' params validation threw:`,
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          const reason = error instanceof Error ? error.message : String(error);
          return noop(doc, `${def.name} rejected: invalid params — ${reason}`);
        }
        if (!checked.success) {
          return noop(
            doc,
            `${def.name} rejected: invalid params — ${formatIssues(checked.error)}. Document unchanged.`,
          );
        }
      }
      let result: CommandResult;
      try {
        result = def.run(doc, safeParams, ctx ?? currentContext());
      } catch (error) {
        console.warn(
          `[llull] command '${def.name}' threw:`,
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        const reason = error instanceof Error ? error.message : String(error);
        return noop(doc, `${def.name} failed: ${reason}; document unchanged.`);
      }
      const violation = derivationViolation(pluginGuards(), def.name, doc, result.document);
      if (violation !== null) {
        return noop(doc, violation);
      }
      if (result.document !== doc) {
        for (const id of result.affected) {
          const reason = corruptionReason(result.document.entities[id]);
          if (reason !== null) {
            return noop(
              doc,
              `${def.name} rejected: result for ${id} contains ${reason}. Document unchanged.`,
            );
          }
        }
      }
      return result;
    },
  };
}
