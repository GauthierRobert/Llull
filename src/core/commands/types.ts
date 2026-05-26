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
  /**
   * Ids of entities created or affected — lets the caller select/highlight them.
   * @invariant Ordering MUST be deterministic for the same (doc-shape, params): the
   * feature-history replay (Q4) positionally zips a step's recorded `affected` (old ids)
   * with the replay's `affected` (new ids) to remap downstream id references. A command
   * that creates multiple entities must list them in a stable order across runs.
   */
  affected: string[];
  /**
   * Structured result for read-only/query commands (e.g. measure_distance,
   * mass_properties). Absent on mutating commands; lets a programmatic agent read
   * a value instead of parsing `summary`. Passes through `execute` and the MCP layer.
   * @example { distance: 42, unit: 'mm' }
   */
  data?: unknown;
}

export type Command<P> = (doc: CadDocument, params: P) => CommandResult;

/**
 * Safety annotations for a command. Emitted verbatim as MCP tool `annotations`.
 * Field names follow the MCP Tool Annotations spec (readOnlyHint, destructiveHint, idempotentHint).
 *
 * @see https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/#tool-annotations
 */
export interface CommandAnnotations {
  /**
   * When true: the command never mutates the document. It returns the SAME document
   * reference, `affected:[]`, and a `data` field with query results.
   * Safe to call at any time without side effects.
   * Maps to MCP `annotations.readOnlyHint`.
   */
  readonly readOnly?: boolean;
  /**
   * When true: the command removes or irreversibly destroys document content (e.g. delete_entity,
   * delete_layer). Agents should prefer confirmation or undo before calling.
   * Maps to MCP `annotations.destructiveHint`.
   */
  readonly destructive?: boolean;
  /**
   * When true: calling the command twice with the same params produces the same end-state as
   * calling it once (setter/renamer semantics). Safe to retry on network failure.
   * Maps to MCP `annotations.idempotentHint`.
   */
  readonly idempotent?: boolean;
  /**
   * When true: `execute()` must NOT append a new FeatureStep for this command. Covers three
   * cases that are not replayable geometry steps: history meta-commands (which edit the
   * featureHistory list itself — appending would recurse), `load_document` (wholesale doc
   * replacement), and parameter-table commands (`set_parameter`/`delete_parameter`) whose
   * effect is document INPUT state, not recipe geometry (architecture L8). Not emitted to
   * MCP tool schemas.
   */
  readonly metaHistory?: boolean;
}

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
  /**
   * Optional safety hints for AI agents and MCP clients.
   * Emitted as MCP tool `annotations`. Absent means no special semantics.
   */
  readonly annotations?: CommandAnnotations;
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSpec>;
  required: string[];
}

/** The JSON-schema value kinds a parameter (or nested element) may take. */
export type ParamType = 'number' | 'string' | 'boolean' | 'array' | 'object';

export interface ParamSpec {
  type: ParamType;
  description: string;
  /**
   * Constrained value set (JSON Schema `enum`). Emitted verbatim into the tool
   * schema so agents see the allowed choices.
   */
  enum?: readonly (string | number)[];
  /** For `type: 'array'`: the schema of each element. */
  items?: ParamItemSpec;
  /** For `type: 'object'`: named child properties, each a full `ParamSpec`. */
  properties?: Record<string, ParamSpec>;
}

/**
 * Element/nested schema (array items). Same shape as `ParamSpec` but `description`
 * is optional — a primitive array element (`items: { type: 'number' }`) needs none.
 */
export interface ParamItemSpec {
  type: ParamType;
  description?: string;
  enum?: readonly (string | number)[];
  items?: ParamItemSpec;
  properties?: Record<string, ParamSpec>;
}
