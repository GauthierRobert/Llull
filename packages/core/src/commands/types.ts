/**
 * Command contracts: a command is the ONE unit of change. Each is a pure function
 * `(document, params, ctx?) -> CommandResult` that returns a new document; the UI, the AI bridge
 * and the MCP server all invoke the same set through `execute`.
 */

import type { CadDocument } from '../model/types';
import type { ExecutionContext } from './context';
import type { ZodType } from 'zod';

export interface CommandResult {
  /** The next document state. */
  document: CadDocument;
  /** Human/AI-readable summary of what happened (the agent's feedback signal). */
  summary: string;
  /**
   * Ids of entities created or affected (the caller selects/highlights them).
   * @invariant deterministic order for the same (doc-shape, params): feature-history replay zips a
   *   step's recorded `affected` with the replay's positionally to remap downstream id references.
   */
  affected: string[];
  /**
   * Structured result of read-only/query commands (e.g. `{ distance: 42, unit: 'mm' }`); absent on
   * mutating commands. Passes through `execute` and the MCP layer.
   */
  data?: unknown;
  /**
   * Set by `execute`/`guardCommand` only when the call was refused before or around `run`
   * (unknown command, invalid params, kernel unavailable, derivation guard, `run` threw, corrupt
   * result). Absent on success and on a command's own graceful no-op. Surfaces map it to an error.
   */
  rejected?: true;
}

/** Safety annotations; emitted as MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint). */
export interface CommandAnnotations {
  /** Never mutates the document: returns the SAME document, `affected: []`, results in `data`. */
  readonly readOnly?: boolean;
  /** Removes or irreversibly destroys document content (e.g. delete_entity, delete_layer). */
  readonly destructive?: boolean;
  /** Calling twice with the same params gives the same end state as once (setter semantics). */
  readonly idempotent?: boolean;
  /**
   * `execute()` appends no FeatureStep: history meta-commands (appending would recurse),
   * `load_document` (wholesale replacement) and parameter-table commands (document INPUT state,
   * architecture L8). Not emitted to MCP.
   */
  readonly metaHistory?: boolean;
  /**
   * Needs `ExecutionContext.kernel`: `execute` no-ops it with a "kernel not ready" summary when
   * none is available and `replayHistory` refuses to regenerate a history containing it.
   * Not emitted to MCP.
   */
  readonly requiresKernel?: boolean;
}

/** A registered command: enough metadata to generate the UI affordance, AI tool schema and MCP tool. */
export interface CommandDefinition<P> {
  /** Stable snake_case id, e.g. "add_box"; the MCP/AI tool name. */
  readonly name: string;
  /** One-line description shown to humans and to the AI. */
  readonly description: string;
  /** JSON-schema-like parameter spec derived from the zod params by `defineCommand`. */
  readonly paramsSchema: ParamsSchema;
  /** Runtime validator from the same zod schema; `execute` no-ops with the failing path on mismatch. */
  readonly paramsValidator?: ZodType;
  /** @invariant `ctx` is always supplied by `execute`/`replayHistory`; optional only for direct `run` calls. */
  readonly run: (doc: CadDocument, params: P, ctx?: ExecutionContext) => CommandResult;
  readonly annotations?: CommandAnnotations;
}

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSpec>;
  required: string[];
}

/** The JSON-schema value kinds a parameter (or nested element) may take. */
export type ParamType = 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object';

/** Array element / nested schema: the `description` is optional. */
export interface ParamItemSpec {
  type: ParamType;
  description?: string;
  /** Constrained value set (JSON Schema `enum`). */
  enum?: readonly (string | number)[];
  /** For `type: 'array'`: the schema of each element. */
  items?: ParamItemSpec;
  /** For `type: 'object'`: named child properties. */
  properties?: Record<string, ParamSpec>;
  /** For `type: 'object'`: child properties that must be present. */
  required?: readonly string[];
}

/** A named parameter: an item spec that must carry a `description`. */
export interface ParamSpec extends ParamItemSpec {
  description: string;
}
