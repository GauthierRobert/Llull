import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';

/**
 * @layer tests/production
 *
 * Production-scenario gate contract. A scenario is one real engineering-office job (bureau
 * d'études): a client brief, the tool calls an engineer would make, and the acceptance criteria
 * the office checks before issuing deliverables. Three drivers run the same scenario and the same
 * criteria grade the result:
 *   scripted — deterministic tool calls through the real `/mcp` endpoint (server/tests/production)
 *   ui       — a human-like flow in the browser (tests/production/ui.gate.ts, Playwright)
 *   agent    — an AI agent given only `brief`, through `/mcp` (server/tests/production)
 *
 * @invariant criteria read only the final document + deliverables, never driver internals
 */

export type DriverId = 'scripted' | 'ui' | 'agent';

/** One MCP tool call, exactly as an agent would send it. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * A deliverable the office issues, produced from the final document:
 * `ifc` · `dxf:<levelId>` · `plan:<levelId>` · `elevation:<direction>` · `schedule:<kind>` ·
 * `takeoff` · `save` (serialized document) · civil: `landxml` ·
 * `plan-profile:<alignmentId>:<paper>`.
 */
export type DeliverableId = string;

export interface GradeContext {
  document: CadDocument;
  /** Document the scenario started from (revision scenarios), else an empty document. */
  baseline: CadDocument;
  /** Run a command on the final document (read-only / export use). */
  run(tool: string, args?: Record<string, unknown>): CommandResult;
  /** The deliverable's text: the file the driver downloaded, else produced from `document`. */
  deliverable(id: DeliverableId): string;
  /** The same deliverable produced from `baseline`. */
  baselineDeliverable(id: DeliverableId): string;
}

export interface CheckOutcome {
  pass: boolean;
  /** Factual, specific: counts, ids, measured vs expected. */
  detail: string;
}

export type CriterionArea =
  | 'structure'
  | 'equipment'
  | 'piping'
  | 'coordination'
  | 'engineering'
  | 'deliverables'
  | 'data-integrity'
  | 'survey'
  | 'earthworks'
  | 'roads'
  | 'drainage';

export interface Criterion {
  /** kebab-case, unique per scenario; the id used in `knownIssues`. */
  id: string;
  area: CriterionArea;
  /** What the office requires, in one sentence. */
  requirement: string;
  check(ctx: GradeContext): CheckOutcome;
}

export interface Scenario {
  id: string;
  title: string;
  client: string;
  /** Scenario whose final document this one starts from (revisions). */
  startsFrom?: string;
  /** The complete brief handed to the AI agent: every value the criteria check is in it. */
  brief: string;
  /** Deterministic tool-call sequence (scripted driver). */
  script: ToolCall[];
  criteria: Criterion[];
  /** Criteria that fail today, per driver. Ratchet: a known issue that passes fails the gate. */
  knownIssues: Partial<Record<DriverId, string[]>>;
  /**
   * Minimum share of the job an AI agent must complete: criteria failing on the starting document
   * (minus known product gaps) that pass at the end, net of criteria it broke. Raise it over time.
   */
  agentBaseline: number;
}

export interface CheckReport extends CheckOutcome {
  id: string;
  area: CriterionArea;
  requirement: string;
  known: boolean;
}

export interface ScenarioReport {
  scenario: string;
  title: string;
  driver: DriverId;
  checks: CheckReport[];
  passed: number;
  total: number;
  /** Criteria that fail and are not known issues. */
  regressions: string[];
  /** Known issues that now pass (remove them from `knownIssues`). */
  fixed: string[];
}
