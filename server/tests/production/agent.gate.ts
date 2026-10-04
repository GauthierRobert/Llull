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
 * PRODUCTION_AGENT_EFFORT (high) · PRODUCTION_AGENT_MAX_TURNS (150) · PRODUCTION_AGENT_TRIALS (1)
 *
 * @invariant each trial passes at least `scenario.agentBaseline` of the criteria
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { gradeContext, gradeScenario } from '../../../tests/production/grade';
import { formatReport, writeArtifact, writeReport } from '../../../tests/production/report';
import { SCENARIOS, chainOf } from '../../../tests/production/scenarios';
import type { Scenario } from '../../../tests/production/contract';
import { runAgent, type AgentOptions } from './agentLoop';
import { liveDocument, resetDocument, startServer, stopServer } from './mcpHarness';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const effort = process.env['PRODUCTION_AGENT_EFFORT'] ?? 'high';
if (!(EFFORTS as readonly string[]).includes(effort)) {
  throw new Error(`PRODUCTION_AGENT_EFFORT must be one of ${EFFORTS.join(', ')}`);
}
const OPTIONS: AgentOptions = {
  model: process.env['PRODUCTION_AGENT_MODEL'] ?? 'claude-opus-5-5',
  effort: effort as AgentOptions['effort'],
  maxTurns: Number(process.env['PRODUCTION_AGENT_MAX_TURNS'] ?? 150),
};
const TRIALS = Number(process.env['PRODUCTION_AGENT_TRIALS'] ?? 1);
const SELECTED = (process.env['PRODUCTION_SCENARIOS'] ?? '').split(',').filter((id) => id !== '');

beforeAll(startServer);
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
        const run = await runAgent(scenario.brief, OPTIONS);
        const report = gradeScenario(scenario, 'agent', gradeContext(liveDocument(), baseline));
        const { transcript, ...stats } = run;
        const id = TRIALS > 1 ? `${scenario.id}-trial${trial}` : scenario.id;
        writeReport(
          { ...report, scenario: id },
          { ...OPTIONS, ...stats, agentBaseline: scenario.agentBaseline },
        );
        writeArtifact('agent', id, 'transcript.json', JSON.stringify(transcript, null, 2));
        writeArtifact(
          'agent',
          id,
          'final.llull.json',
          gradeContext(liveDocument()).deliverable('save'),
        );
        const share = report.passed / report.total;
        expect(
          share,
          `${formatReport(report)}\n\nagent: ${run.turns} turns, ${run.toolCalls} tool calls ` +
            `(${run.toolErrors} errors), stop ${run.stopReason}\n${run.finalText}`,
        ).toBeGreaterThanOrEqual(scenario.agentBaseline);
      });
    }
  }
});
