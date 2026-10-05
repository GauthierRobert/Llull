/**
 * @layer server/tests/production
 *
 * The AI-agent driver's loop: Claude receives the job brief and works it through llull's MCP
 * tools only (manual tool-use loop over an MCP session). The tool array is fixed for the whole
 * conversation (every llull tool; those outside the session's enabled toolsets are deferred and
 * found with tool search), so calling a not-yet-enabled tool returns llull's own guidance to call
 * enable_toolset — the same discovery path any MCP client meets.
 */

import Anthropic from '@anthropic-ai/sdk';
import { TOOLSET_NAMES } from '@mcp/toolsets';
import { openSession, type McpSession } from './mcpHarness';

/** One model turn. Default: the Anthropic Messages API; tests inject a stub. */
export type SendTurn = (
  params: Anthropic.Beta.MessageCreateParamsStreaming,
) => Promise<Anthropic.Beta.BetaMessage>;

const sendToApi: SendTurn = (params) => new Anthropic().beta.messages.stream(params).finalMessage();

export interface AgentOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
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

type ToolDefinition = Awaited<ReturnType<McpSession['client']['listTools']>>['tools'][number];

/** Every llull tool, listed from a throwaway session with all toolsets enabled. */
async function allTools(): Promise<ToolDefinition[]> {
  const lister = await openSession('production-agent-lister');
  try {
    for (const toolset of TOOLSET_NAMES) await lister.call('enable_toolset', { toolset });
    return (await lister.client.listTools()).tools;
  } finally {
    await lister.close();
  }
}

function toApiTools(tools: ToolDefinition[], loaded: Set<string>): Anthropic.Beta.BetaToolUnion[] {
  const custom: Anthropic.Beta.BetaToolUnion[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    defer_loading: !loaded.has(tool.name),
  }));
  return [{ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' }, ...custom];
}

/** MCP result content → tool_result content (text + images, e.g. render_view PNGs). */
function toResultContent(
  content: unknown,
): Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> {
  const blocks: Array<Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam> = [];
  for (const item of Array.isArray(content) ? content : []) {
    const block = item as { type?: string; text?: string; data?: string; mimeType?: string };
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'image' &&
      typeof block.data === 'string' &&
      block.mimeType === 'image/png'
    ) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: block.data },
      });
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(no content)' }];
}

export async function runAgent(
  brief: string,
  options: AgentOptions,
  send: SendTurn = sendToApi,
): Promise<AgentRun> {
  const tools = await allTools();
  const session = await openSession('production-agent');
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
    wallMs: 0,
    transcript: [],
  };
  try {
    const loaded = new Set((await session.client.listTools()).tools.map((tool) => tool.name));
    const apiTools = toApiTools(tools, loaded);
    const instructions = session.client.getInstructions() ?? '';
    const system =
      instructions === '' ? SYSTEM : `${SYSTEM}\n\nllull server instructions:\n${instructions}`;
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
      run.stopReason = message.stop_reason ?? '';
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
      if (text.length > 0) run.finalText = text.join('\n');
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content });
        continue;
      }
      const toolUses = message.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
      );
      if (message.stop_reason !== 'tool_use' || toolUses.length === 0) break;
      messages.push({ role: 'assistant', content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const raw = await session.client.callTool({
          name: toolUse.name,
          arguments: (toolUse.input ?? {}) as Record<string, unknown>,
        });
        const content = toResultContent(raw.content);
        const isError = raw.isError === true;
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
    await session.close();
  }
  return run;
}
