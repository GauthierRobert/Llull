/**
 * @layer server/tests/production
 *
 * Production gate, scripted driver: each engineering-office scenario's tool calls are sent through
 * the real /mcp endpoint (Streamable HTTP), like an MCP agent would — the session discovers and
 * enables the toolsets it needs — then the live document is graded against the office's acceptance
 * criteria (tests/production). Reports: .cache/production/reports/scripted/.
 *
 *   npm run production:scripted
 *
 * @invariant exactly the scenario's `knownIssues.scripted` criteria fail (ratchet)
 */

import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCommand } from '@core/commands/registry';
import { toolsetOf } from '@mcp/toolsets';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import type { Scenario, ToolCall } from '../../../tests/production/contract';
import { gradeContext, gradeScenario } from '../../../tests/production/grade';
import { formatReport, resetReports, writeReport } from '../../../tests/production/report';
import { SCENARIOS, chainOf } from '../../../tests/production/scenarios';
import { estimateUsd, runAgent, type SendTurn } from './agentLoop';
import { liveDocument, openSession, resetDocument, startServer, stopServer } from './mcpHarness';

beforeAll(async () => {
  resetReports('scripted');
  await startServer();
});
afterAll(stopServer);

/** Run a scenario's calls in one MCP session on the current live document. */
async function drive(scenario: Scenario): Promise<{ calls: number; ms: number }> {
  const session = await openSession(`production-scripted-${scenario.id}`);
  const started = Date.now();
  try {
    const toolsets = new Set(
      scenario.script
        .map((call) => toolsetOf(call.tool))
        .filter((t) => t !== undefined && t !== 'core'),
    );
    for (const toolset of toolsets) {
      const enabled = await session.call('enable_toolset', { toolset });
      expect(enabled.isError, enabled.text).toBe(false);
    }
    for (const call of scenario.script) {
      const before = liveDocument();
      const outcome = await session.call(call.tool, call.args);
      expect(outcome.isError, `${call.tool}: ${outcome.text}`).toBe(false);
      // A soft failure returns isError:false with the document unchanged.
      if (getCommand(call.tool)?.annotations?.readOnly !== true) {
        expect(liveDocument(), `${call.tool} changed nothing: ${outcome.text}`).not.toBe(before);
      }
      expect(outcome.text, `${call.tool}`).not.toMatch(/\brejected\b/i);
    }
  } finally {
    await session.close();
  }
  return { calls: scenario.script.length, ms: Date.now() - started };
}

/** Default `/mcp` limit (server/src/mcp/middleware.ts): requests per minute per IP. */
const DEFAULT_MCP_LIMIT = 600;

describe('each job fits the default /mcp rate limit', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, () => {
      // One request per tool call, plus session setup (initialize + notification) and one
      // enable_toolset per toolset, for the job itself (its starting model is already there).
      const toolsets = new Set(scenario.script.map((call) => toolsetOf(call.tool)));
      const requests = scenario.script.length + toolsets.size + 2;
      expect(requests).toBeLessThan(DEFAULT_MCP_LIMIT);
    });
  }
});

describe('production scenarios — scripted driver over /mcp', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.id, async () => {
      resetDocument(createEmptyDocument());
      let baseline: CadDocument = createEmptyDocument();
      let run = { calls: 0, ms: 0 };
      for (const step of chainOf(scenario)) {
        baseline = liveDocument();
        run = await drive(step);
      }
      const report = gradeScenario(scenario, 'scripted', gradeContext(liveDocument(), baseline));
      writeReport(report, { toolCalls: run.calls, wallMs: run.ms });
      const failing = report.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`);
      expect(report.regressions, `${formatReport(report)}\n${failing.join('\n')}`).toEqual([]);
      expect(report.fixed, 'known issues now passing — remove them from knownIssues').toEqual([]);
    });
  }
});

/**
 * The AI-agent driver's loop (agentLoop.ts) with a stub model that replays the scripted calls as
 * tool_use blocks: proves the loop, tool listing / deferral and MCP plumbing without API credentials.
 */
describe('AI-agent loop plumbing (stub model)', () => {
  it('replays desmet-extraction-building through runAgent and grades like the scripted driver', async () => {
    const scenario = SCENARIOS[0];
    if (!scenario) throw new Error('no scenario');
    resetDocument(createEmptyDocument());
    const pending: ToolCall[] = [
      { tool: 'add_level', args: { name: 'probe', elevation: 0, height: 1000 } }, // not enabled yet
      { tool: 'enable_toolset', args: { toolset: 'building' } },
      ...scenario.script,
    ];
    let seenTools = 0;
    let deferred = 0;
    const send: SendTurn = (params) => {
      seenTools = params.tools?.length ?? 0;
      deferred = (params.tools ?? []).filter(
        (t) => 'defer_loading' in t && t.defer_loading === true,
      ).length;
      const batch = pending.splice(0, pending.length > scenario.script.length ? 1 : 25);
      const content = batch.map((call, index) => ({
        type: 'tool_use' as const,
        id: `toolu_${pending.length}_${index}`,
        name: call.tool,
        input: call.args,
      }));
      return Promise.resolve(
        stubMessage(content.length > 0 ? content : [{ type: 'text', text: 'Done.' }]),
      );
    };
    const run = await runAgent(
      scenario.brief,
      { model: 'stub', effort: 'high', maxTurns: 50, maxUsd: 1 },
      send,
    );
    expect(seenTools).toBeGreaterThan(100);
    expect(deferred).toBeGreaterThan(0);
    expect(run.transcript[0]?.isError).toBe(true);
    expect(run.transcript[0]?.result).toMatch(/enable_toolset/);
    expect(run.toolErrors).toBe(1);
    expect(run.stopReason).toBe('end_turn');
    const report = gradeScenario(scenario, 'scripted', gradeContext(liveDocument()));
    expect(report.regressions).toEqual([]);
  });
});

describe('AI-agent cost estimate and budget cap (stub model)', () => {
  it('prices tokens at the model list price', () => {
    const usd = estimateUsd('claude-opus-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 0,
    });
    expect(usd).toBeCloseTo(4 + 2 + 0.4, 6);
    expect(
      estimateUsd('unknown-model', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  it('stops the job when the estimated spend reaches the cap', async () => {
    resetDocument(createEmptyDocument());
    let turns = 0;
    const send: SendTurn = () => {
      turns++;
      const probe = {
        type: 'tool_use' as const,
        id: `toolu_${turns}`,
        name: 'describe_building',
        input: {},
      };
      return Promise.resolve(stubMessage([probe], { input: 500_000, output: 50_000 }));
    };
    const run = await runAgent(
      'Budget probe.',
      { model: 'claude-opus-5-5', effort: 'high', maxTurns: 50, maxUsd: 5 },
      send,
    );
    expect(run.stopReason).toMatch(/^budget/);
    expect(turns).toBe(2); // 3 USD per turn: the second turn crosses 5 USD
    expect(run.estimatedUsd).toBeCloseTo(6, 6);
  });
});

function stubMessage(
  content: unknown[],
  tokens: { input: number; output: number } = { input: 0, output: 0 },
): Anthropic.Beta.BetaMessage {
  const toolUse = content.some((block) => (block as { type: string }).type === 'tool_use');
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content,
    stop_reason: toolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as Anthropic.Beta.BetaMessage;
}
