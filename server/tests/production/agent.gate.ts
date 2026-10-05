/**
 * @layer server/tests/production
 *
 * Production gate, AI-agent driver: Claude gets ONLY the scenario brief (what a lead engineer
 * hands a designer) and must do the job through llull's MCP tools; the result is graded with the
 * same acceptance criteria as the scripted and UI drivers. Revision scenarios start from the
 * previous issue, produced by the scripted calls (the colleague's model).
 *
 *   npm run production:agent        # needs Anthropic API credentials; costs real money
 *
 * Env: PRODUCTION_SCENARIOS (comma ids, default all) · PRODUCTION_AGENT_MODEL (claude-opus-5-5) ·
 * PRODUCTION_AGENT_EFFORT (high) · PRODUCTION_AGENT_MAX_TURNS (150) · PRODUCTION_AGENT_TRIALS (1) ·
 * PRODUCTION_AGENT_MAX_USD (20, estimated spend cap per trial; the report records the estimate)
 *
 * Scoring: only the job's criteria count — those that fail on the starting document and are not
 * known product gaps (`knownIssues.scripted`) — plus any criterion that passed on the starting
 * document and fails at the end (the agent broke it). Doing nothing, or a partial model that
 * leaves vacuous checks green, cannot pass.
 *
 * @invariant each trial passes at least `scenario.agentBaseline` of the job's criteria
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { gradeContext, gradeScenario } from '../../../tests/production/grade';
import {
  formatReport,
  resetReports,
  writeArtifact,
  writeReport,
} from '../../../tests/production/report';
import { SCENARIOS, chainOf } from '../../../tests/production/scenarios';
import type { Scenario } from '../../../tests/production/contract';
import { runAgent, type AgentOptions } from './agentLoop';
import { liveDocument, resetDocument, startServer, stopServer } from './mcpHarness';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const effort = process.env['PRODUCTION_AGENT_EFFORT'] ?? 'high';
if (!(EFFORTS as readonly string[]).includes(effort)) {
  throw new Error(`PRODUCTION_AGENT_EFFORT must be one of ${EFFORTS.join(', ')}`);
}
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name} must be a positive number`);
  return value;
}
const OPTIONS: AgentOptions = {
  model: process.env['PRODUCTION_AGENT_MODEL'] ?? 'claude-opus-5-5',
  effort: effort as AgentOptions['effort'],
  maxTurns: positiveInteger('PRODUCTION_AGENT_MAX_TURNS', 150),
  maxUsd: positiveNumber('PRODUCTION_AGENT_MAX_USD', 20),
};
const TRIALS = positiveInteger('PRODUCTION_AGENT_TRIALS', 1);
const SELECTED = (process.env['PRODUCTION_SCENARIOS'] ?? '').split(',').filter((id) => id !== '');

beforeAll(async () => {
  resetReports('agent');
  await startServer();
});
afterAll(stopServer);

/** The document a scenario starts from: its predecessors' scripted calls, in-process. */
function startingDocument(scenario: Scenario): CadDocument {
  let doc = createEmptyDocument();
  for (const step of chainOf(scenario).slice(0, -1)) {
    for (const call of step.script) doc = execute(doc, call.tool, call.args).document;
  }
  return doc;
}

describe('production scenarios — AI agent over /mcp', () => {
  const scenarios = SCENARIOS.filter((s) => SELECTED.length === 0 || SELECTED.includes(s.id));
  for (const scenario of scenarios) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      it(`${scenario.id} (trial ${trial}/${TRIALS}, ${OPTIONS.model} @ ${OPTIONS.effort})`, async () => {
        const baseline = startingDocument(scenario);
        resetDocument(baseline);
        const before = gradeScenario(scenario, 'agent', gradeContext(baseline, baseline));
        const gaps = new Set(scenario.knownIssues.scripted ?? []);
        const job = before.checks.filter((c) => !c.pass && !gaps.has(c.id)).map((c) => c.id);
        const run = await runAgent(scenario.brief, OPTIONS);
        const report = gradeScenario(scenario, 'agent', gradeContext(liveDocument(), baseline));
        const done = report.checks.filter((c) => c.pass && job.includes(c.id)).map((c) => c.id);
        const broken = report.checks
          .filter((c) => !c.pass && before.checks.some((b) => b.id === c.id && b.pass))
          .map((c) => c.id);
        const { transcript, ...stats } = run;
        const id = TRIALS > 1 ? `${scenario.id}-trial${trial}` : scenario.id;
        writeReport(
          { ...report, scenario: id },
          { ...OPTIONS, ...stats, agentBaseline: scenario.agentBaseline, job, done, broken },
        );
        writeArtifact('agent', id, 'transcript.json', JSON.stringify(transcript, null, 2));
        writeArtifact(
          'agent',
          id,
          'final.llull.json',
          gradeContext(liveDocument()).deliverable('save'),
        );
        expect(
          job.length,
          'the starting document already passes every job criterion',
        ).toBeGreaterThan(0);
        const share = done.length / (job.length + broken.length);
        expect(
          share,
          `${formatReport(report)}\n\njob criteria done ${done.length}/${job.length}, broken: ` +
            `${broken.join(', ') || 'none'}; ` +
            `agent: ${run.turns} turns, ${run.toolCalls} tool calls ` +
            `(${run.toolErrors} errors), stop ${run.stopReason}, ~${run.estimatedUsd?.toFixed(2) ?? '?'} USD\n${run.finalText}`,
        ).toBeGreaterThanOrEqual(scenario.agentBaseline);
      });
    }
  }
});
