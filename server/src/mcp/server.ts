/**
 * @layer server
 * One MCP `Server` per session over the shared live document. Tool logic lives in `@mcp`; this
 * file binds it to the SDK handlers. Every tools/call runs `execute` exactly once, through
 * `commandBus.applyCommand` (shared undo history + `/live` broadcast).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  buildAllMcpTools,
  shapeToolCallContent,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
  SERVER_INSTRUCTIONS,
  applyExchangeToolCall,
  applyDiscoveryToolCall,
  isPromptEnabled,
  closestToolNames,
  isToolEnabled,
  searchTools,
  toolsetOf,
} from '@mcp/index';
import { getCommand } from '@core/commands/registry';
import type { ToolsetName } from '@mcp/index';
import { errorMessage } from '@lib/errorMessage';
import { getLiveDoc } from '../liveDocument';
import { applyCommand } from '../commandBus';
import type { ExchangeOptions } from '../pythonExchange';
import { buildImageBlock, stripSvgFromData } from '../renderImage';

function makeErrorResult(message: string): CallToolResult {
  return shapeToolCallContent({ summary: message, affected: [], isError: true });
}

/** Unknown tool: same "Unknown command" text as `execute`, plus the closest tool names. */
function unknownToolResult(
  name: string,
  enabledToolsets: ReadonlySet<ToolsetName>,
): CallToolResult {
  const typoMatches = closestToolNames(name, 5);
  const suggestions =
    typoMatches.length > 0
      ? typoMatches
      : searchTools(name.replace(/_/g, ' '), 5, enabledToolsets).map((r) => r.name);
  const hint = suggestions.length > 0 ? ` Closest tools: ${suggestions.join(', ')}.` : '';
  return makeErrorResult(
    `Unknown command: ${name}.${hint} Use search_tools to find tools by keyword.`,
  );
}

/** Tool list for a session: registry tools + exchange/discovery meta-tools, filtered by toolset. */
function listTools(enabledToolsets: ReadonlySet<ToolsetName>): {
  tools: { name: string; description: string; inputSchema: { type: 'object' } }[];
} {
  return {
    tools: buildAllMcpTools()
      .filter((t) => isToolEnabled(t.name, enabledToolsets))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object' },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
  };
}

export function buildMcpServer(
  exchange: ExchangeOptions,
  configuredToolsets: ReadonlySet<ToolsetName>,
): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  /** Per-session: the configured set, grown by the `enable_toolset` discovery tool. */
  const enabledToolsets = new Set<ToolsetName>(configuredToolsets);

  server.setRequestHandler(ListToolsRequestSchema, () => listTools(enabledToolsets));

  const handleToolCall = async (req: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;

    const disabledToolset = isToolEnabled(name, enabledToolsets) ? undefined : toolsetOf(name);
    if (disabledToolset !== undefined) {
      return makeErrorResult(
        `Tool ${name} is disabled on this server: enable its toolset "${disabledToolset}" in ` +
          'LLULL_TOOLSETS, call enable_toolset to load it for this session (search_tools finds ' +
          'tools by keyword), or call it as a build_project step.',
      );
    }

    const discovery = applyDiscoveryToolCall(name, args, enabledToolsets);
    if (discovery !== null) {
      if (discovery.toolsListChanged) server.sendToolListChanged().catch(() => {});
      return discovery.result;
    }

    // export_step / import_step / import_code: Python I/O behind the injected port; document
    // changes still go through registry commands on the command bus.
    const exchangeResult = await applyExchangeToolCall(name, args, {
      port: exchange.port,
      getDoc: getLiveDoc,
      applyCommand,
      allowCodeExecution: exchange.allowCodeExecution,
    });
    if (exchangeResult !== null) return exchangeResult;

    if (getCommand(name) === undefined) return unknownToolResult(name, enabledToolsets);

    const busResult = applyCommand(name, args ?? {});

    // Vision loop: the PNG replaces the multi-KB SVG in the text/structured content.
    const imageBlock = buildImageBlock(busResult.data);
    const shaped = shapeToolCallContent(
      imageBlock !== null ? { ...busResult, data: stripSvgFromData(busResult.data) } : busResult,
    );
    return imageBlock !== null ? { ...shaped, content: [...shaped.content, imageBlock] } : shaped;
  };

  // Tool failures are returned as MCP isError results, never thrown as JSON-RPC errors.
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      return await handleToolCall(req);
    } catch (err: unknown) {
      return makeErrorResult(`Tool ${req.params.name} failed: ${errorMessage(err)}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: listMcpResources() }));

  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const { uri } = req.params;
    const content = readMcpResource(getLiveDoc(), uri);
    if (content === null) throw new Error(`Unknown resource URI: ${uri}`);
    return { contents: [content] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: listMcpPrompts().filter((prompt) => isPromptEnabled(prompt.name, enabledToolsets)),
  }));

  server.setRequestHandler(GetPromptRequestSchema, (req): GetPromptResult => {
    const { name, arguments: rawArgs } = req.params;
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawArgs ?? {})) {
      if (typeof v === 'string') args[k] = v;
    }
    const result = isPromptEnabled(name, enabledToolsets) ? getMcpPrompt(name, args) : null;
    if (result === null) throw new Error(`Unknown prompt: ${name}`);
    return result as GetPromptResult;
  });

  return server;
}
