/**
 * The AI-agent driver's loop: Claude receives the job brief and works it through llull's tools only, each tool call
 * run exactly as the `llull` CLI runs it against the backend (`cliHarness.callTool`). The tool array is the CLI catalog
 * (registry commands + exchange / FE / library tools, schemas from `toToolSchemas()`); tools outside the `core` toolset
 * are deferred and found with tool search, so the model sees what `llull list core` shows and searches like `llull search`.
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildAllTools } from '@protocol/discovery';
import { toolsetOf } from '@protocol/toolsets';
import { CONVENTIONS_GUIDE } from '@protocol/conventions';
import type { ToolDefinition } from '@protocol/tools';
import { buildImageBlock } from '../../src/renderImage';
import { callTool } from './cliHarness';

/** One model turn. Default: the Anthropic Messages API; tests inject a stub. */
export type SendTurn = (params: Anthropic.Beta.MessageCreateParamsStreaming) => Promise<Anthropic.Beta.BetaMessage>;

const sendToApi: SendTurn = (params) => new Anthropic().beta.messages.stream(params).finalMessage();

export interface AgentOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
  /** Stop the job once the estimated spend reaches this many US dollars (Infinity = no cap). */
  maxUsd: number;
}

/** USD per million tokens (input, output, cache read, cache write) — Claude API list prices. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};

/** Estimated spend of a run so far; null when the model has no listed price. */
export function estimateUsd(
  model: string,
  run: Pick<AgentRun, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  return (
    (run.inputTokens * price.input +
      run.outputTokens * price.output +
      run.cacheReadTokens * price.cacheRead +
      run.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

export interface AgentTranscriptEntry {
  turn: number;
  tool: string;
  input: unknown;
  result: string;
  isError: boolean;
}

export interface AgentRun {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  stopReason: string;
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Estimated spend in USD (null when the model has no listed price). */
  estimatedUsd: number | null;
  wallMs: number;
  transcript: AgentTranscriptEntry[];
}

const SYSTEM = [
  'You are a design engineer in a process-plant engineering office (bureau d’études).',
  'You work in llull, a CAD application, exclusively through its tools: every model change is a tool call.',
  'Do the whole job described by the lead engineer, then verify it with llull’s read-only tools',
  '(describe_building, check_clashes, measure / schedule tools) and fix what is wrong.',
  'Prefer batching many similar operations into one build_project call when llull offers it.',
  'When you are done, reply with a short completion note listing anything you could not do in llull.',
].join(' ');

function toApiTools(tools: readonly ToolDefinition[]): Anthropic.Beta.BetaToolUnion[] {
  const custom: Anthropic.Beta.BetaToolUnion[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    defer_loading: (toolsetOf(tool.name) ?? 'core') !== 'core',
  }));
  return [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' }, ...custom];
}

/** CLI result text, plus a PNG of any `data.svg` (render_view, sheets): the vision loop of the agent. */
async function toResultContent(
  text: string,
  data: unknown,
): Promise<Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam>> {
  const image = await buildImageBlock(data);
  const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [
    { type: 'text', text: text === '' ? '(no content)' : text },
  ];
  if (image !== null) blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } });
  return blocks;
}

export async function runAgent(brief: string, options: AgentOptions, send: SendTurn = sendToApi): Promise<AgentRun> {
  const apiTools = toApiTools(buildAllTools());
  const system = `${SYSTEM}\n\nllull modeling conventions (\`llull guide\`):\n${CONVENTIONS_GUIDE}`;
  const started = Date.now();
  const run: AgentRun = {
    turns: 0,
    toolCalls: 0,
    toolErrors: 0,
    stopReason: '',
    finalText: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedUsd: 0,
    wallMs: 0,
    transcript: [],
  };
  try {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: brief }];
    while (run.turns < options.maxTurns) {
      run.turns++;
      const message = await send({
        stream: true,
        model: options.model,
        max_tokens: 64000,
        system,
        tools: apiTools,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: options.effort },
        cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
      run.inputTokens += message.usage.input_tokens;
      run.outputTokens += message.usage.output_tokens;
      run.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
      run.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
      run.estimatedUsd = estimateUsd(options.model, run);
      if (run.estimatedUsd !== null && run.estimatedUsd >= options.maxUsd) {
        run.stopReason = `budget (${run.estimatedUsd.toFixed(2)} USD ≥ ${options.maxUsd} USD)`;
        break;
      }
      run.stopReason = message.stop_reason ?? '';
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
      if (text.length > 0) run.finalText = text.join('\n');
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      const toolUses = message.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (message.stop_reason !== 'tool_use' || toolUses.length === 0) break;
      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const outcome = await callTool(toolUse.name, (toolUse.input ?? {}) as Record<string, unknown>);
        const content = await toResultContent(outcome.text, outcome.data);
        const isError = outcome.isError;
        run.toolCalls++;
        if (isError) run.toolErrors++;
        run.transcript.push({
          turn: run.turns,
          tool: toolUse.name,
          input: toolUse.input,
          result: content
            .map((block) => (block.type === 'text' ? block.text : '[image]'))
            .join('\n')
            .slice(0, 2000),
          isError,
        });
        results.push({ type: 'tool_result', tool_use_id: toolUse.id, content, is_error: isError });
      }
      messages.push({ role: 'user', content: results });
    }
  } finally {
    run.wallMs = Date.now() - started;
  }
  return run;
}
