/** @layer ui/panels Pure rules of the configurations panel (no document access). */

import type { Configuration, Parameter } from '@core/model/types';

export interface ParameterValueRow {
  readonly paramName: string;
  readonly expression: string;
}

/** A configuration is active when each of its parameters currently has its expression. */
export function isConfigurationActive(
  config: Configuration,
  parameters: Readonly<Record<string, Parameter>>,
): boolean {
  const entries = Object.entries(config.parameterValues);
  return (
    entries.length > 0 && entries.every(([name, expr]) => parameters[name]?.expression === expr)
  );
}

/**
 * The `create_configuration` params from the form, or null while the name is blank, no row is
 * filled in, or a row is half filled. Fully blank rows are ignored.
 */
export function configurationDraftOf(
  name: string,
  rows: ReadonlyArray<ParameterValueRow>,
): { name: string; parameterValues: Record<string, string> } | null {
  const filled = rows.filter((r) => r.paramName.trim() !== '' || r.expression.trim() !== '');
  const complete =
    name.trim() !== '' &&
    filled.length > 0 &&
    filled.every((r) => r.paramName.trim() !== '' && r.expression.trim() !== '');
  if (!complete) return null;
  const parameterValues: Record<string, string> = {};
  for (const row of filled) parameterValues[row.paramName.trim()] = row.expression.trim();
  return { name: name.trim(), parameterValues };
}
