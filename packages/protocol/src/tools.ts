/**
 * Tool definitions generated from the command registry (`toToolSchemas()` is the only source; no schema is
 * hand-written here): what the `llull` CLI lists, searches and describes.
 */

import type { ParamsSchema } from '@core/commands/types';
import { toToolSchemas, type ToolSchema } from '@core/commands/registry';

/** `inputSchema` is the command's `paramsSchema`; `annotations` is present only when the command has any. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ParamsSchema;
  annotations?: NonNullable<ToolSchema['annotations']>;
}

/** @invariant buildCommandTools()[i].name === listCommands()[i].name for all i */
export function buildCommandTools(): ToolDefinition[] {
  return toToolSchemas().map(({ name, description, input_schema, annotations }) => ({
    name,
    description,
    inputSchema: input_schema,
    ...(annotations ? { annotations } : {}),
  }));
}
