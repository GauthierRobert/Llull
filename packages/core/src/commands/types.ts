/**
 * Command contracts: a command is the ONE unit of change. Each is a pure function `(document, params, ctx?) -> CommandResult` that returns
 * a new document; the UI, the AI bridge and the MCP server all invoke the same set through `execute`.
 */

import type { CadDocument } from '../model/types';
import type { GeometryKernel } from '../geometry/kernel';
import type { PhysicsEngine } from '../dynamics/physicsEngine';
import type { FeArtifactPort, HumanSignaturePort } from '../model/analysis';
import type { MaterialLibrary } from '../model/materialLibrary';
import type { IdSource } from '../lib/id';
import type { ReplayCache } from './history/replayCache';
import type { ZodType } from 'zod';

export interface CommandResult {
  /** The next document state. */
  document: CadDocument;
  /** Human/AI-readable summary of what happened (the agent's feedback signal). */
  summary: string;
  /**
   * Ids of entities created or affected (the caller selects/highlights them).
   * @invariant deterministic order for the same (doc-shape, params): feature-history replay zips a step's recorded `affected` with the
   *   replay's positionally to remap downstream id references.
   */
  affected: string[];
  /**
   * Structured result of read-only/query commands (e.g. `{ distance: 42, unit: 'mm' }`); absent on mutating commands. Passes through
   * `execute` and the MCP layer.
   */
  data?: unknown;
  /**
   * Set by `execute`/`guardCommand` only when the call was refused before or around `run` (unknown command, invalid params, kernel
   * unavailable, derivation guard, `run` threw, corrupt result). Absent on success and on a command's own graceful no-op. Surfaces map it
   * to an error.
   */
  rejected?: true;
  /** Machine-readable reason of a refusal (always set with `rejected`; a command may also set it on its own no-op). */
  error?: CommandError;
}

/**
 * A refusal an agent can script on (AGENT_FIRST AF-11): a stable `code` (`CMD_*` registry, `PLAN_*` build_project, pack prefixes such
 * as `KRN_*`), the offending entity ids, the offending locations (param paths such as `size.0`, or plan paths such as
 * `step 4 › iter 2 › step 1`) and a one-line fix.
 */
export interface CommandError {
  readonly code: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly remediation: string;
}

/** Safety annotations; emitted as MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint). */
export interface CommandAnnotations {
  /** Never mutates the document: returns the SAME document, `affected: []`, results in `data`. */
  readonly readOnly?: boolean;
  /** Removes or irreversibly destroys document content (e.g. delete_entities, delete_layer). */
  readonly destructive?: boolean;
  /** Calling twice with the same params gives the same end state as once (setter semantics). */
  readonly idempotent?: boolean;
  /**
   * `execute()` appends no FeatureStep: history meta-commands (appending would recurse), `load_document` (wholesale replacement) and
   * parameter-table commands (document INPUT state, architecture L8). Not emitted to MCP.
   */
  readonly metaHistory?: boolean;
  /**
   * Session command (OQ-MAT-09): changes the in-memory document only. `execute` appends no FeatureStep and the host neither logs nor
   * syncs it; its effect is never serialized (private material-library values, TR-MAT-31). Not emitted to MCP.
   */
  readonly session?: boolean;
  /**
   * Needs `ExecutionContext.kernel`: `execute` no-ops it with a "kernel not ready" summary when none is available and `replayHistory`
   * refuses to regenerate a history containing it. Not emitted to MCP.
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

/**
 * Maps the params of a retired command onto the call that replaced it. Persistence applies it to saved feature-history / recipe steps so
 * documents recorded before the merge still replay.
 */
export type RetiredCommandRewrite = (
  params: Record<string, unknown>,
  /** The saved top-level history step; absent for nested plan actions and recipe steps. */
  step?: { readonly id: string },
) => { readonly name: string; readonly params: Record<string, unknown> };

export interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSpec>;
  required: string[];
}

/** The JSON-schema value kinds a parameter (or nested element) may take. */
export type ParamType = 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'object';

/** Array element / nested schema: the `description` is optional. */
export interface ParamItemSpec {
  /** Absent only when `anyOf` lists the alternatives (a union of differing types). */
  type?: ParamType;
  /** JSON Schema `anyOf`: the value must match one of these branches (zod union / discriminated union). */
  anyOf?: ParamItemSpec[];
  description?: string;
  /** Constrained value set (JSON Schema `enum`). */
  enum?: readonly (string | number)[];
  /** For numbers: inclusive bounds (JSON Schema `minimum` / `maximum`); set by hand-written transport schemas, never derived from zod. */
  minimum?: number;
  maximum?: number;
  /** For `type: 'array'`: the schema of each element. */
  items?: ParamItemSpec;
  /** For `type: 'object'`: named child properties. */
  properties?: Record<string, ParamSpec>;
  /** For `type: 'object'`: child properties that must be present. */
  required?: readonly string[];
  /** For a record (`type: 'object'` keyed by any string): the schema of every value (JSON Schema `additionalProperties`). */
  additionalProperties?: ParamItemSpec;
}

/** A named parameter: an item spec that must carry a `description`. */
export interface ParamSpec extends ParamItemSpec {
  description: string;
}

/**
 * Execution context — the injected dependencies of one `execute` call (runtime: `context.ts`).
 * @invariant a command reads its kernel, id source and registry ONLY from its context (architecture L9); no command touches a module-level
 *   singleton.
 */
export type CommandLookup = (name: string) => CommandDefinition<unknown> | undefined;

/** Progress of a running `build_project`: a `start` and an `end` event per executed command. */
export interface PlanStepEvent {
  readonly phase: 'start' | 'end';
  /** 1-based ordinal of this executed command (loop iterations count one each). */
  readonly ordinal: number;
  /** Executed commands the plan expands to (an upper bound when a step fails or is skipped). */
  readonly total: number;
  readonly command: string;
  /** Index of the plan action this command belongs to. */
  readonly index: number;
  /** `end` only: whether the step succeeded. */
  readonly ok?: boolean;
  /** `end` only: position of the step's report in `data.steps`. */
  readonly stepPosition?: number;
}

/**
 * Read-only access to material library files held on this machine (08 MAT M3, `~/.llull/libraries/` on the server). Private-library
 * values reach a document only through this port; absent / null = none installed.
 */
export interface MaterialLibraryProvider {
  /** The library `libraryId` at `version`, or null when this machine does not hold it (or the file is not a valid library). */
  get(libraryId: string, version: string): MaterialLibrary | null;
}

export interface ExecutionContext {
  /** Geometry kernel for booleans/fillets; null while none is installed or loaded. */
  readonly kernel: GeometryKernel | null;
  /** Rigid-body physics engine for `simulate_motion`; null/absent while none is installed. */
  readonly physics?: PhysicsEngine | null;
  /** Read-only FE mesh/results artifact store (host-provided); null/absent = `record_fe_*` commands no-op with FEA_ARTIFACT_NOT_FOUND. */
  readonly feaArtifacts?: FeArtifactPort | null;
  /** Human-signature verifier (09 PLM); null/absent = human-gate commands refuse. */
  readonly humanSignature?: HumanSignaturePort | null;
  /** Material library files of this machine (`import_material_library` by reference, `resolve_material_libraries`); null/absent = none. */
  readonly libraries?: MaterialLibraryProvider | null;
  /** Mints every id the command creates. */
  readonly ids: IdSource;
  /** Resolves command names for commands that run other commands. */
  readonly registry: CommandLookup;
  /** Nesting depth of `build_project` plans (re-entrancy guard). */
  readonly projectDepth: number;
  /** Nesting depth of `instantiate_recipe` expansions (re-entrancy guard). */
  readonly recipeDepth: number;
  /**
   * Key of the feature-history step currently running, if any. A nested `execute` inside a step belongs to that step: it mints from the
   * same id source and appends no step of its own.
   */
  readonly stepKey?: string;
  /** Replay prefix cache; null disables it. Results depend on the kernel, so the default context keeps one cache per installed kernel. */
  readonly replayCache: ReplayCache | null;
  /**
   * Observer of `build_project` execution (CLI progress, timeouts); a throw aborts the plan. Optional and side-effect only: it never
   * changes a result.
   */
  readonly onStep?: (event: PlanStepEvent) => void;
}
