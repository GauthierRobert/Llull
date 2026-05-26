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
import type { CommandDefinition, CommandResult } from './types';
import { reEvaluateAll } from './parameters';
import { replayHistory } from './history';

// ---------------------------------------------------------------------------
// Late-bound registry reference (mirrors history.ts pattern to break cycle)
// ---------------------------------------------------------------------------

let _getCommand: ((name: string) => CommandDefinition<unknown> | undefined) | null = null;

/**
 * Called once from registry.ts to wire up the getCommand reference.
 * Must be called before any activate_configuration `run` executes.
 */
export function setConfigRegistryRef(
  getCommandFn: (name: string) => CommandDefinition<unknown> | undefined,
): void {
  _getCommand = getCommandFn;
}

function resolveGetCommand(): (name: string) => CommandDefinition<unknown> | undefined {
  return _getCommand ?? (() => undefined);
}

// ---------------------------------------------------------------------------
// create_configuration
// ---------------------------------------------------------------------------

interface CreateConfigurationParams {
  name: string;
  parameterValues: Record<string, string>;
}

/**
 * @command create_configuration
 * @pure
 * @layer core/commands
 * @affects adds or replaces an entry in CadDocument.configurations
 * @invariant existing configurations with different names are not touched
 * @failure blank name → no-op; parameterValues not an object of strings → no-op
 */
export const createConfiguration: CommandDefinition<CreateConfigurationParams> = {
  name: 'create_configuration',
  description:
    'Define or replace a named configuration (design-table variant). ' +
    'A configuration is a named set of parameter expressions that represents one variant ' +
    'of the model (e.g. "small": {w:"10"}, "large": {w:"40"}). ' +
    'Storing a configuration does NOT change any geometry — call activate_configuration to apply it. ' +
    'If a configuration with the same name already exists it is replaced.',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Human-readable identifier for the configuration, e.g. "small", "production_v2". ' +
          'Must be a non-empty string. Used as both the display name and the lookup key for activate_configuration.',
      },
      parameterValues: {
        type: 'object',
        description:
          'Map of parameter name → expression string that defines this variant. ' +
          'Each key must be a string (parameter name) and each value must be a string expression ' +
          'in the same format as set_parameter (e.g. {"w": "10", "h": "w * 2"}). ' +
          'Only the parameters listed here are changed when the configuration is activated; ' +
          'all other document parameters keep their current expressions.',
        properties: {},
      },
    },
    required: ['name', 'parameterValues'],
  },
  annotations: { metaHistory: true, idempotent: true },
  run: (doc, { name, parameterValues }): CommandResult => {
    if (typeof name !== 'string' || name.trim() === '') {
      return {
        document: doc,
        summary: 'create_configuration failed: name must be a non-empty string.',
        affected: [],
      };
    }

    if (
      typeof parameterValues !== 'object' ||
      parameterValues === null ||
      Array.isArray(parameterValues)
    ) {
      return {
        document: doc,
        summary: `create_configuration '${name}' failed: parameterValues must be a plain object mapping parameter names to expression strings.`,
        affected: [],
      };
    }

    // Validate that every value is a string expression.
    for (const [k, v] of Object.entries(parameterValues)) {
      if (typeof v !== 'string') {
        return {
          document: doc,
          summary: `create_configuration '${name}' failed: parameterValues['${k}'] must be a string expression, got ${typeof v}.`,
          affected: [],
        };
      }
    }

    const configuration: Configuration = {
      name,
      parameterValues: { ...parameterValues },
    };

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
};

// ---------------------------------------------------------------------------
// activate_configuration
// ---------------------------------------------------------------------------

interface ActivateConfigurationParams {
  name: string;
}

/**
 * @command activate_configuration
 * @pure
 * @layer core/commands
 * @affects parameters record + all entities (via featureHistory replay)
 * @invariant featureHistory is preserved unchanged after replay
 * @failure unknown config name → no-op; unknown parameter in config → summary note, no throw
 */
export const activateConfiguration: CommandDefinition<ActivateConfigurationParams> = {
  name: 'activate_configuration',
  description:
    'Apply a named configuration to the document: set each parameter listed in the ' +
    'configuration to its expression value, re-evaluate the parameter table in topological ' +
    'order, then replay featureHistory so all =expr geometry regenerates with the variant\'s values. ' +
    'Use after create_configuration to switch between model variants (e.g. "small" vs "large"). ' +
    'The configuration must already exist in the document (call create_configuration first).',
  paramsSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Name of the configuration to activate. Must match an existing configuration ' +
          'created by create_configuration (case-sensitive). ' +
          'Example: "small", "large", "production_v2".',
      },
    },
    required: ['name'],
  },
  // idempotent: activating the same configuration twice yields the same end-state
  // (sets the same parameter values, replays the same history). metaHistory: it sets
  // document INPUT state and triggers a replay, so it must not append/recurse (L8).
  annotations: { idempotent: true, metaHistory: true },
  run: (doc, { name }): CommandResult => {
    if (typeof name !== 'string' || name.trim() === '') {
      return {
        document: doc,
        summary: 'activate_configuration failed: name must be a non-empty string.',
        affected: [],
      };
    }

    const config = doc.configurations[name];
    if (!config) {
      const available = Object.keys(doc.configurations);
      const hint =
        available.length > 0
          ? ` Available configurations: ${available.join(', ')}.`
          : ' No configurations have been defined yet (use create_configuration first).';
      return {
        document: doc,
        summary: `activate_configuration failed: configuration '${name}' not found.${hint}`,
        affected: [],
      };
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
    const regenerated = replayHistory(
      baseDoc,
      doc.featureHistory,
      resolveGetCommand(),
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
      parts.push(
        `Unresolved expressions (${warnings.length}): ${warnings.join('; ')}.`,
      );
    }

    return {
      document: regenerated,
      summary: parts.join(' '),
      affected: regenerated.order,
    };
  },
};
