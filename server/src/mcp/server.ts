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
  buildMcpTools,
  shapeToolCallContent,
  listMcpResources,
  readMcpResource,
  listMcpPrompts,
  getMcpPrompt,
  buildExchangeToolDefinitions,
  applyExchangeToolCall,
  buildDiscoveryToolDefinitions,
  applyDiscoveryToolCall,
  isPromptEnabled,
  isToolEnabled,
  toolsetOf,
} from '@mcp/index';
import type { ToolsetName } from '@mcp/index';
import { getLiveDoc } from '../liveDocument';
import { applyCommand } from '../commandBus';
import type { ExchangeOptions } from '../pythonExchange';
import { buildImageBlock, stripSvgFromData } from '../renderImage';
import {
  applyRenderViewEnrichments,
  makeErrorResult,
  stripEnrichParams,
} from './renderViewEnrichment';
import { augmentRenderViewTool } from './renderViewSchema';

/** Tool list for a session: registry tools + exchange/discovery meta-tools, filtered by toolset. */
function listTools(enabledToolsets: ReadonlySet<ToolsetName>): {
  tools: { name: string; description: string; inputSchema: { type: 'object' } }[];
} {
  const registryTools = buildMcpTools().map((t) =>
    t.name === 'render_view'
      ? augmentRenderViewTool(t)
      : {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as { type: 'object' },
        },
  );
  const metaTools = [...buildExchangeToolDefinitions(), ...buildDiscoveryToolDefinitions()].map(
    (t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }),
  );
  return {
    tools: [...registryTools, ...metaTools].filter((t) => isToolEnabled(t.name, enabledToolsets)),
  };
}

export function buildMcpServer(
  exchange: ExchangeOptions,
  configuredToolsets: ReadonlySet<ToolsetName>,
): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
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
      return discovery.result as unknown as CallToolResult;
    }

    // export_step / import_step / import_code: Python I/O behind the injected port; document
    // changes still go through registry commands on the command bus.
    const exchangeResult = await applyExchangeToolCall(name, args, {
      port: exchange.port,
      getDoc: getLiveDoc,
      applyCommand,
      allowCodeExecution: exchange.allowCodeExecution,
    });
    if (exchangeResult !== null) return exchangeResult as unknown as CallToolResult;

    // render_view enrichments are server-side; their params are stripped before the core command.
    if (name === 'render_view' && args != null) {
      const enriched = applyRenderViewEnrichments(args, getLiveDoc);
      if (enriched !== null) return enriched;
    }

    const busResult = applyCommand(
      name,
      name === 'render_view' ? stripEnrichParams(args ?? {}) : (args ?? {}),
    );

    // Vision loop: the PNG replaces the multi-KB SVG in the text/structured content.
    const imageBlock = buildImageBlock(busResult.data);
    const shaped = shapeToolCallContent(
      imageBlock !== null ? { ...busResult, data: stripSvgFromData(busResult.data) } : busResult,
    ) as CallToolResult;
    if (imageBlock !== null) (shaped.content as unknown[]).push(imageBlock);
    return shaped;
  };

  // Tool failures are returned as MCP isError results, never thrown as JSON-RPC errors.
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    try {
      return await handleToolCall(req);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return makeErrorResult(`Tool ${req.params.name} failed: ${message}`);
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
