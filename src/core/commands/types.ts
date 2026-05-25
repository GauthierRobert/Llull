/**
 * Command contracts.
 *
 * A Command is the ONE unit of change in the system. The same command set is
 * invoked by:
 *   - the React UI (button clicks, gizmo drags)
 *   - the AI bridge (Claude tool calls)
 *   - the MCP server (external agents)
 *
 * Each command is a pure function: (document, params) -> CommandResult.
 * It never mutates its input; it returns a new document. This makes undo/redo,
 * testing, and AI replay trivial.
 */

import type { CadDocument } from '../model/types';

export interface CommandResult {
  /** The next document state. */
  document: CadDocument;
  /** Human/AI-readable summary of what happened (great for AI feedback loops). */
  summary: string;
  /** Ids of entities created or affected — lets the caller select/highlight them. */
  affected: string[];
}

export type Command<P> = (doc: CadDocument, params: P) => CommandResult;

/**
 * A registered command, carrying enough metadata to auto-generate:
 *   - UI affordances
 *   - the AI tool schema
 *   - the MCP tool definition
 * Defining a command once gives you all three surfaces for free.
 */
export interface CommandDefinition<P> {
  /** Stable id, e.g. "add_box". Used as the MCP/AI tool name. */
  readonly name: string;
  /** One-line description shown to humans and to the AI. */
  readonly description: string;
  /** JSON-schema-like parameter spec, consumed by the AI/MCP tool generators. */
  readonly paramsSchema: ParamsSchema;
  readonly run: Command<P>;
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSpec>;
  required: string[];
}

export interface ParamSpec {
  type: 'number' | 'string' | 'boolean' | 'array';
  description: string;
  items?: { type: string };
}
