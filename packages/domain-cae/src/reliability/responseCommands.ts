/** define_response (PHY-18): names a scalar read from a read-only registry command so limit states and sensitivities can use it. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import { getCommand } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { refuseReliability } from './codes';
import { reliabilityOf, responseOf, withReliability } from './model';
import { queryValue } from './responseEval';
import type { Response } from '@cae/reliability/types';

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/**
 * @affects doc.probabilistic.responses (adds or replaces the response called `name`; affected: [response id])
 * @invariant the query command is registered and readOnly; the name is not a random variable, document parameter or built-in constant
 * @failure bad name / name clash / unknown or mutating command / pointer without a leading '/' -> PRB_PARAMS_INVALID / PRB_RESPONSE_NOT_QUERY (unchanged doc)
 */
export const defineResponse = defineCommand({
  name: 'define_response',
  description:
    'Define (or replace, by name) a RESPONSE: a number read from the result of a read-only (query) command, e.g. the mass of a part: ' +
    '{ name: "mass", unit: "g", query: { command: "mass_properties", params: { entityId: "box-1" }, pointer: "/data/mass" } }. ' +
    'Use the response `name` as a symbol in define_limit_state expressions (e.g. "22 - mass") and as `response` of parameter_sensitivity / sensitivity_indices. ' +
    'Every evaluation runs the query on an in-memory copy of the document after set_parameter on the random variables bound to document parameters, so geometry regenerates (slow: studies on responses are capped at 20000 evaluations). ' +
    "`pointer` is an RFC 6901 JSON pointer applied to the query result { summary, affected, data }, so numbers are at '/data/...'. The command must be registered and readOnly. " +
    'Returns the response id (rs-<step>.<k>) in affected[0]; the summary states the current value, or why it is not evaluable now.',
  params: z.object({
    name: z.string().describe('Response name (letters, digits, underscores); a symbol in limit-state expressions.'),
    unit: z.string().describe("Unit of the number the pointer reads, e.g. 'g' or 'mm'."),
    query: z
      .object({
        command: z.string().describe('Name of a registered read-only command, e.g. "mass_properties".'),
        params: z.record(z.string(), z.unknown()).describe('Params of that command (entity ids etc.).'),
        pointer: z.string().describe("RFC 6901 JSON pointer into { summary, affected, data } of the result, e.g. '/data/mass'."),
      })
      .describe('The read-only command and where the number is in its result.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: string[]): CommandResult =>
      refuseReliability(doc, 'define_response', code, message, [params.name], paths);
    const model = reliabilityOf(doc);
    if (!IDENTIFIER.test(params.name)) return fail('PRB_PARAMS_INVALID', `name '${params.name}' is not an identifier`, ['name']);
    if (Object.hasOwn(model.variables, params.name) || Object.hasOwn(doc.parameters, params.name) || ['pi', 'tau'].includes(params.name))
      return fail('PRB_PARAMS_INVALID', `name '${params.name}' is already a random variable, a document parameter or a constant`, ['name']);
    const command = getCommand(params.query.command);
    if (command === undefined)
      return fail('PRB_RESPONSE_NOT_QUERY', `no registered command '${params.query.command}'`, ['query', 'command']);
    if (command.annotations?.readOnly !== true)
      return fail('PRB_RESPONSE_NOT_QUERY', `'${params.query.command}' is not read-only: a response must be a query`, ['query', 'command']);
    if (!params.query.pointer.startsWith('/'))
      return fail('PRB_PARAMS_INVALID', `pointer '${params.query.pointer}' must start with '/' (e.g. '/data/mass')`, ['query', 'pointer']);
    const id = nextId('rs');
    const response: Response = { id, name: params.name, unit: params.unit, query: params.query };
    const replaced = responseOf(doc, params.name) !== undefined;
    const next = withReliability(doc, {
      ...model,
      responses: { ...model.responses, [params.name]: response },
      responseOrder: replaced ? (model.responseOrder ?? []) : [...(model.responseOrder ?? []), params.name],
    });
    const probe = queryValue(doc, params.query, ctx);
    return changed(
      next,
      `${replaced ? 'Replaced' : 'Defined'} response ${id} '${params.name}' [${params.unit}] = ${params.query.command}${params.query.pointer}; ` +
        (probe.ok ? `current value ${probe.value} ${params.unit}.` : `not evaluable now (${probe.reason}).`),
      [id],
    );
  },
});
