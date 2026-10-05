/**
 * create_configuration / activate_configuration: design-table variants. Configurations are document
 * INPUT state, so both are `metaHistory`.
 *
 * @layer core/commands
 */

import type { CadDocument, Configuration } from '../model/types';
import { kernelRefusal } from './kernelRefusal';
import { currentContext } from './context';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { reEvaluateAll, withParameterExpression } from './parameters';
import { replayHistory } from './replay';
import { unresolvedExpressionsNote } from './replayStep';
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
    if (name.trim() === '') {
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
      configurations: { ...doc.configurations, [name]: configuration },
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

    // Parameters named in the config but absent from the document are created (and reported).
    const unknownParams = Object.keys(config.parameterValues).filter(
      (paramName) => !(paramName in doc.parameters),
    );
    const changedParams = Object.entries(config.parameterValues).map(
      ([paramName, expression]) => `${paramName}="${expression}"`,
    );
    // The seed value is kept when evaluation fails (reEvaluateAll retains the last good value).
    const updatedParameters = Object.entries(config.parameterValues).reduce(
      (table, [paramName, expression]) => withParameterExpression(table, paramName, expression),
      doc.parameters,
    );
    const baseDoc: CadDocument = { ...doc, parameters: reEvaluateAll(updatedParameters) };

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

    const createdNote =
      unknownParams.length > 0
        ? ` Warning: created ${unknownParams.length} new parameter(s) not previously in the document: ${unknownParams.join(', ')}.`
        : '';

    return {
      document: regenerated,
      summary:
        `activate_configuration '${name}': applied ${changedParams.length} parameter${changedParams.length === 1 ? '' : 's'} (${changedParams.join(', ')}) ` +
        `regenerated ${entityCount} ${entityCount === 1 ? 'entity' : 'entities'}.` +
        createdNote +
        unresolvedExpressionsNote(warnings),
      affected: regenerated.order,
    };
  },
});
