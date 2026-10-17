/** One MCP `Server` per session binding `@mcp` to the SDK; each tools/call runs `execute` once via `applyCommand`. */
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
  applyDiscoveryToolCall,
  isPromptEnabled,
  suggestToolNames,
  isToolEnabled,
  toolsetOf,
  redactLicensedOutcome,
} from '@mcp/index';
import { getCommand, listCommands } from '@core/commands/registry';
import type { ToolsetName } from '@mcp/index';
import { errorMessage } from '@lib/errorMessage';
import { getLiveDoc } from '../liveDocument';
import { ANONYMOUS_ACTOR, type Actor } from '../audit';
import { applyLiveExchangeToolCall } from '../liveExchange';
import type { Role } from '../users';
import { applyCommand } from '../commandBus';
import type { ExchangeOptions } from '../pythonExchange';
import { buildImageBlock, stripSvgFromData } from '../renderImage';

const makeErrorResult = (message: string): CallToolResult => shapeToolCallContent({ summary: message, affected: [], isError: true });

/** Unknown tool: same "Unknown command" text as `execute`, plus the closest tool names. */
function unknownToolResult(name: string, enabledToolsets: ReadonlySet<ToolsetName>): CallToolResult {
  const suggestions = suggestToolNames(name, 5, enabledToolsets);
  const hint = suggestions.length > 0 ? ` Closest tools: ${suggestions.join(', ')}.` : '';
  return makeErrorResult(`Unknown command: ${name}.${hint} Use search_tools to find tools by keyword.`);
}

/** `role: null` = no named-user auth (full access). */
interface McpCaller {
  readonly actor: Actor;
  readonly role: Role | null;
  /** Not a direct loopback peer: licensed material values are redacted from its answers (TR-MAT-32). */
  readonly remote?: boolean;
}

/** What a viewer may call. */
let readOnlyCache: { readonly count: number; readonly names: ReadonlySet<string> } | null = null;
const isReadOnlyTool = (name: string): boolean => {
  const count = listCommands().length; // registry changes (plugin install) change the count
  if (readOnlyCache === null || readOnlyCache.count !== count) {
    readOnlyCache = { count, names: new Set(buildAllMcpTools().flatMap((t) => (t.annotations?.readOnlyHint === true ? [t.name] : []))) };
  }
  return readOnlyCache.names.has(name);
};

export function buildMcpServer(
  exchange: ExchangeOptions,
  configuredToolsets: ReadonlySet<ToolsetName>,
  caller: McpCaller = { actor: ANONYMOUS_ACTOR('mcp'), role: null },
): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  const enabledToolsets = new Set<ToolsetName>(configuredToolsets); // grown by `enable_toolset`

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: buildAllMcpTools()
      .filter((t) => isToolEnabled(t.name, enabledToolsets))
      .filter((t) => caller.role !== 'viewer' || t.name === 'enable_toolset' || t.annotations?.readOnlyHint === true)
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object' },
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
  }));

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
    if (caller.role === 'viewer' && !isReadOnlyTool(name)) {
      return makeErrorResult(
        `Forbidden — role "viewer" may only call read-only tools; ${name} can change the document. ` +
          'Ask an administrator for the "editor" role.',
      );
    }
    // Exchange tools: Python I/O behind the injected port; document changes still go through the command bus.
    const exchangeResult = await applyLiveExchangeToolCall(name, args, exchange, caller.actor);
    if (exchangeResult !== null) return exchangeResult;
    if (getCommand(name) === undefined) return unknownToolResult(name, enabledToolsets);
    const applied = applyCommand(name, args ?? {}, undefined, caller.actor);
    const busResult = caller.remote === true ? redactLicensedOutcome(getLiveDoc(), name, args, applied) : applied;
    // Vision loop: the PNG replaces the multi-KB SVG in the text/structured content.
    const imageBlock = buildImageBlock(busResult.data);
    const shaped = shapeToolCallContent(imageBlock !== null ? { ...busResult, data: stripSvgFromData(busResult.data) } : busResult);
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
    const args = Object.fromEntries(
      Object.entries(rawArgs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const result = isPromptEnabled(name, enabledToolsets) ? getMcpPrompt(name, args) : null;
    if (result === null) throw new Error(`Unknown prompt: ${name}`);
    return result as GetPromptResult;
  });

  return server;
}
