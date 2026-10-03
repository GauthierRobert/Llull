/**
 * @command create_configuration
 * @command activate_configuration
 * @pure
 * @layer core/commands
 * @affects configurations record (create_configuration); parameters + entities (activate_configuration)
 * @invariant configurations are document INPUT state, not replayable geometry steps (metaHistory: true)
 * @failure blank name / non-object parameterValues → no-op; unknown config name → no-op; unknown parameter → summary surfaces it, no throw
 */

import type { CadDocument, Configuration, Parameter } from '../model/types';
import { kernelRefusal } from './kernelRefusal';
import { currentContext } from './context';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { reEvaluateAll } from './parameters';
import { replayHistory } from './history';
import { noop } from './noop';

/**
 * @command create_configuration
 * @pure
 * @layer core/commands
 * @affects adds or replaces an entry in CadDocument.configurations
 * @invariant existing configurations with different names are not touched
 * @failure blank name → no-op; parameterValues not an object of strings → no-op
 */
export const createConfiguration = defineCommand({
  name: 'create_configuration',
  description:
    'Define or replace a named configuration (design-table variant). ' +
    'A configuration is a named set of parameter expressions that represents one variant ' +
    'of the model (e.g. "small": {w:"10"}, "large": {w:"40"}). ' +
    'Storing a configuration does NOT change any geometry — call activate_configuration to apply it. ' +
    'If a configuration with the same name already exists it is replaced.',
  params: z.object({
    name: z
      .string()
      .describe(
        'Human-readable identifier for the configuration, e.g. "small", "production_v2". ' +
          'Must be a non-empty string. Used as both the display name and the lookup key for activate_configuration.',
      ),
    // Values are checked in run (each must be a string expression) so the summary names the key.
    parameterValues: z
      .looseObject({})
      .describe(
        'Map of parameter name → expression string that defines this variant. ' +
          'Each key must be a string (parameter name) and each value must be a string expression ' +
          'in the same format as set_parameter (e.g. {"w": "10", "h": "w * 2"}). ' +
          'Only the parameters listed here are changed when the configuration is activated; ' +
          'all other document parameters keep their current expressions.',
      ),
  }),
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { name, parameterValues }): CommandResult => {
    if (typeof name !== 'string' || name.trim() === '') {
      return noop(doc, 'create_configuration failed: name must be a non-empty string.');
    }

    const expressions: Record<string, string> = {};
    for (const [k, v] of Object.entries(parameterValues)) {
      if (typeof v === 'string') {
        expressions[k] = v;
      } else {
        return noop(
          doc,
          `create_configuration '${name}' failed: parameterValues['${k}'] must be a string expression, got ${typeof v}.`,
        );
      }
    }

    const configuration: Configuration = { name, parameterValues: expressions };

    const newDoc: CadDocument = {
      ...doc,
      configurations: {
        ...doc.configurations,
        [name]: configuration,
      },
    };

    const paramCount = Object.keys(parameterValues).length;
    return {
      document: newDoc,
      summary: `create_configuration '${name}': stored with ${paramCount} parameter${paramCount === 1 ? '' : 's'} (${Object.keys(parameterValues).join(', ')}).`,
      affected: [],
    };
  },
});

/**
 * @command activate_configuration
 * @pure
 * @layer core/commands
 * @affects parameters record + all entities (via featureHistory replay)
 * @invariant featureHistory is preserved unchanged after replay
 * @failure unknown config name → no-op; unknown parameter in config → summary note, no throw
 */
export const activateConfiguration = defineCommand({
  name: 'activate_configuration',
  description:
    'Apply a named configuration to the document: set each parameter listed in the ' +
    'configuration to its expression value, re-evaluate the parameter table in topological ' +
    "order, then replay featureHistory so all =expr geometry regenerates with the variant's values. " +
    'Use after create_configuration to switch between model variants (e.g. "small" vs "large"). ' +
    'The configuration must already exist in the document (call create_configuration first).',
  params: z.object({
    name: z
      .string()
      .describe(
        'Name of the configuration to activate. Must match an existing configuration ' +
          'created by create_configuration (case-sensitive). ' +
          'Example: "small", "large", "production_v2".',
      ),
  }),
  // idempotent: activating the same configuration twice yields the same end-state
  // (sets the same parameter values, replays the same history). metaHistory: it sets
  // document INPUT state and triggers a replay, so it must not append/recurse (L8).
  annotations: { idempotent: true, metaHistory: true },
  run: (doc, { name }): CommandResult => {
    if (name.trim() === '') {
      return noop(doc, 'activate_configuration failed: name must be a non-empty string.');
    }

    const config = doc.configurations[name];
    if (!config) {
      const available = Object.keys(doc.configurations);
      const hint =
        available.length > 0
          ? ` Available configurations: ${available.join(', ')}.`
          : ' No configurations have been defined yet (use create_configuration first).';
      return noop(doc, `activate_configuration failed: configuration '${name}' not found.${hint}`);
    }

    // Apply this configuration's parameter expressions to the current parameters record.
    // Parameters that exist in the doc are updated; parameters named in the config but
    // absent from the doc are created. Surface unknown-parameter notes in the summary.
    const unknownParams: string[] = [];
    const changedParams: string[] = [];

    let updatedParameters: Record<string, Parameter> = { ...doc.parameters };

    for (const [paramName, expression] of Object.entries(config.parameterValues)) {
      if (!(paramName in doc.parameters)) {
        unknownParams.push(paramName);
        // Still create the parameter so the config's intent is honoured.
      }
      changedParams.push(`${paramName}="${expression}"`);
      updatedParameters = {
        ...updatedParameters,
        [paramName]: {
          name: paramName,
          expression,
          // Seed value: reEvaluateAll overwrites this on successful evaluation. On
          // eval failure it retains this seed (0 for a newly-created param), so it is
          // the error-retention fallback rather than a value that is always replaced.
          value: doc.parameters[paramName]?.value ?? 0,
        },
      };
    }

    // Re-evaluate all parameters in topological order.
    const evaluatedParameters = reEvaluateAll(updatedParameters);

    // Build the intermediate doc with the new parameter values.
    const baseDoc: CadDocument = {
      ...doc,
      parameters: evaluatedParameters,
    };

    // Replay featureHistory to regenerate entities with the new parameter values.
    const warnings: string[] = [];
    const refused = kernelRefusal(baseDoc, doc.featureHistory);
    if (refused !== null) {
      return noop(doc, `activate_configuration: ${refused}`);
    }
    const regenerated = replayHistory(
      baseDoc,
      doc.featureHistory,
      currentContext().registry,
      warnings,
    );

    const entityCount = Object.keys(regenerated.entities).length;

    const parts: string[] = [
      `activate_configuration '${name}': applied ${changedParams.length} parameter${changedParams.length === 1 ? '' : 's'} (${changedParams.join(', ')})`,
      `regenerated ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}.`,
    ];
    if (unknownParams.length > 0) {
      parts.push(
        `Warning: created ${unknownParams.length} new parameter(s) not previously in the document: ${unknownParams.join(', ')}.`,
      );
    }
    if (warnings.length > 0) {
      parts.push(`Unresolved expressions (${warnings.length}): ${warnings.join('; ')}.`);
    }

    return {
      document: regenerated,
      summary: parts.join(' '),
      affected: regenerated.order,
    };
  },
});
