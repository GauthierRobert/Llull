/**
 * @layer server
 *
 * MCP endpoint — Streamable HTTP transport over the llull command registry.
 *
 * Architecture:
 * - ALL tool logic is delegated to `core/mcp` (`buildMcpTools`, `applyMcpToolCall`).
 * - This file owns ONLY the transport wiring, auth middleware, and rate limiting.
 * - No command/geometry logic lives here (architecture L6).
 *
 * Session model (v3 — shared live document):
 * - Each MCP `initialize` handshake (POST without `mcp-session-id`) creates a new
 *   session entry: a `StreamableHTTPServerTransport` with a UUID session id, and a
 *   bound `Server` whose handlers read/write the SINGLE shared `CadDocument` from
 *   `liveDocument.ts` via `getLiveDoc` / `setLiveDoc`.
 * - Subsequent requests carry the `mcp-session-id` header; the router routes them to
 *   the existing transport.
 * - All sessions see the same document. A mutation by session A is immediately visible
 *   to session B and to the browser UI (broadcast via GET /live SSE).
 * - DELETE terminates the session transport via `onsessionclosed`; the shared document
 *   is untouched.
 *
 * UI<->MCP sync (KI1-followup resolved):
 *   The shared document is the single source of truth for all MCP sessions.
 *   After every mutating `tools/call`, `setLiveDoc(result.document)` stores the new
 *   state and broadcasts it over the GET /live SSE endpoint, which the browser
 *   EventSource subscribes to for live updates.
 */

import { randomUUID } from 'node:crypto';
import { type Request, type Response, type Router, Router as createRouter } from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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
  buildBridgeToolDefinitions,
  applyBridgeToolCall,
} from '@core/mcp';
import type { UiBridge } from '@core/mcp';
import type { CadDocument } from '@core/model/types';
import { getLiveDoc, setLiveDoc } from './liveDocument';
import { applyCommand } from './commandBus';
import { buildImageBlock, stripSvgFromData, rasterizeSvg } from './renderImage';
import {
  buildTurntableFrames,
  buildIsolateSvg,
  appendDimensionLabels,
  appendAxesAndGrid,
  buildSectionSvg,
  type RenderViewEnrichParams,
} from './renderViewEnrich';

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  /** Epoch-ms of the last request routed to this session. Updated on every hit. */
  lastSeenMs: number;
}

/**
 * Live session map: session id → entry.
 * Created on MCP `initialize`; removed by any of three paths:
 *   1. HTTP DELETE  → SDK calls `onsessionclosed`
 *   2. Transport close (e.g. SDK-level cleanup) → `transport.onclose`
 *   3. Idle TTL sweep → `startSessionSweep` evicts entries not seen within TTL
 * The session's document is held in a closure inside the Server's handlers.
 */
const sessions = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Idle-TTL sweep
// ---------------------------------------------------------------------------

/**
 * Default TTL / sweep interval (overridden by env vars).
 *
 * `MCP_SESSION_TTL_MS`   — max idle time before a session is evicted (default 30 min).
 * `MCP_SESSION_SWEEP_MS` — how often the sweep runs (default 60 s).
 *
 * Idle-TTL eviction is the catch-all for HTTP clients that abandon a session
 * without sending DELETE and without triggering a transport close event.
 * Active sessions are never evicted — every routed request touches `lastSeenMs`.
 */
const DEFAULT_TTL_MS = 30 * 60_000;   // 30 min
const DEFAULT_SWEEP_MS = 60_000;       // 60 s

function parsePosInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Start the background sweep.  The timer is `.unref()`'d so it never blocks
 * process exit.  Call once from `buildMcpRouter` — the singleton pattern
 * ensures only one sweep runs per process even if the router is rebuilt.
 */
let sweepStarted = false;

function startSessionSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;

  const ttlMs = parsePosInt(process.env['MCP_SESSION_TTL_MS'], DEFAULT_TTL_MS);
  const sweepMs = parsePosInt(process.env['MCP_SESSION_SWEEP_MS'], DEFAULT_SWEEP_MS);

  console.warn(
    `[mcp] session sweep started — TTL ${ttlMs} ms, sweep every ${sweepMs} ms`,
  );

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeenMs >= ttlMs) {
        console.warn(`[mcp] evicting idle session ${id} (idle ${now - entry.lastSeenMs} ms)`);
        sessions.delete(id);
        // Best-effort close; ignore errors (transport may already be gone).
        entry.transport.close().catch(() => {});
      }
    }
  }, sweepMs);

  // Do not keep the process alive just for housekeeping.
  timer.unref();
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Bearer-token auth guard.
 *
 * If `MCP_AUTH_TOKEN` is set: require `Authorization: Bearer <token>`.
 * If unset: warn once at startup and allow all traffic (local dev only).
 * Never logs the token value.
 */
function buildAuthMiddleware(): (req: Request, res: Response, next: () => void) => void {
  const token = process.env['MCP_AUTH_TOKEN'];
  if (!token) {
    console.warn(
      '[warn] MCP_AUTH_TOKEN is not set — /mcp endpoint is unprotected. Set it in production.',
    );
    return (_req, _res, next) => next();
  }
  const expected = `Bearer ${token}`;
  return (req: Request, res: Response, next: () => void) => {
    if (req.headers['authorization'] !== expected) {
      res.status(401).json({ error: 'Unauthorized — valid Bearer token required.' });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Defaults: 60 requests per minute per IP.
 * Override via `MCP_RATE_LIMIT_MAX` (requests) and `MCP_RATE_LIMIT_WINDOW_MS`.
 */
function buildRateLimiter(): ReturnType<typeof rateLimit> {
  const windowMs = process.env['MCP_RATE_LIMIT_WINDOW_MS']
    ? parseInt(process.env['MCP_RATE_LIMIT_WINDOW_MS'], 10)
    : 60_000;
  const max = process.env['MCP_RATE_LIMIT_MAX']
    ? parseInt(process.env['MCP_RATE_LIMIT_MAX'], 10)
    : 60;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests — please slow down.' },
  });
}

// ---------------------------------------------------------------------------
// render_view enrichment helpers
// ---------------------------------------------------------------------------

/** The set of param keys that are handled server-side (not forwarded to core). */
const ENRICH_PARAM_KEYS = new Set(['turntable', 'isolate', 'showDimensions', 'section', 'showAxes', 'showGrid']);

/**
 * Strip enrichment-only params from a render_view args object so the core
 * command only receives the params it understands (view, width, height).
 */
function stripEnrichParams(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  const record = args as Record<string, unknown>;
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!ENRICH_PARAM_KEYS.has(k)) stripped[k] = v;
  }
  return stripped;
}

/**
 * Apply server-side render_view enrichments when any enrichment param is present.
 *
 * Returns a `CallToolResult` when enrichment was applied, or `null` when no
 * enrichment params are present and neither showAxes nor showGrid are requested
 * (caller falls through to normal applyCommand path).
 *
 * Enrichments are applied in this priority order (only the first mutually-exclusive
 * one wins; showDimensions, showAxes, and showGrid compose with any other enrichment):
 *   1. turntable → N-frame horizontal PNG strip
 *   2. isolate   → highlight specific entities
 *   3. section   → section-plane view
 *   4. showDimensions / showAxes / showGrid only → base render + post-process
 *
 * showAxes and showGrid default to true when not explicitly set to false.
 */
function applyRenderViewEnrichments(
  args: Record<string, unknown>,
  getDoc: () => CadDocument,
): CallToolResult | null {
  const params = args as RenderViewEnrichParams;

  // showAxes and showGrid default to true (not false)
  const wantAxes = params.showAxes !== false;
  const wantGrid = params.showGrid !== false;

  const hasEnrichment =
    params.turntable !== undefined ||
    params.isolate !== undefined ||
    params.showDimensions === true ||
    params.section !== undefined ||
    wantAxes ||
    wantGrid;

  if (!hasEnrichment) return null;

  // Base render params forwarded to core
  const baseView = typeof params.view === 'string' ? params.view : 'iso';
  const baseWidth = typeof params.width === 'number' ? Math.max(64, Math.min(2000, Math.round(params.width))) : 800;
  const baseHeight = typeof params.height === 'number' ? Math.max(64, Math.min(2000, Math.round(params.height))) : 600;

  const doc = getDoc();
  const docUnits: string = doc.units ?? 'mm';

  // ------------------------------------------------------------------
  // turntable: N-frame horizontal strip
  // ------------------------------------------------------------------
  if (params.turntable !== undefined) {
    const frames = Math.max(1, Math.min(12, Math.round(params.turntable.frames)));
    const svgs = buildTurntableFrames(doc, frames, baseView, baseWidth, baseHeight);
    if (svgs === null || svgs.length === 0) {
      return makeErrorResult('render_view turntable: failed to produce frames.');
    }

    // Rasterize each frame and concatenate horizontally into a single SVG strip.
    // We compose the SVGs side-by-side in a wrapper SVG, then rasterize once.
    const totalWidth = baseWidth * svgs.length;
    const stripLines: string[] = [];
    stripLines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${baseHeight}" viewBox="0 0 ${totalWidth} ${baseHeight}">`);
    stripLines.push(`  <rect width="${totalWidth}" height="${baseHeight}" fill="#1a1a2e"/>`);
    for (let i = 0; i < svgs.length; i++) {
      const inner = extractSvgInnerPublic(svgs[i] as string);
      stripLines.push(`  <g transform="translate(${i * baseWidth}, 0)">${inner}</g>`);
    }
    // Frame number labels
    for (let i = 0; i < svgs.length; i++) {
      const angle = Math.round((360 * i) / svgs.length);
      stripLines.push(
        `  <text x="${r2Public(i * baseWidth + 4)}" y="32" font-family="monospace" font-size="13" fill="#aaaacc">${angle}°</text>`,
      );
    }
    stripLines.push('</svg>');
    const stripSvg = stripLines.join('\n');

    const base64 = rasterizeSvg(stripSvg, totalWidth);
    if (base64 === null) {
      return makeErrorResult('render_view turntable: rasterization failed.');
    }

    const summary = `Rendered turntable strip: ${frames} frame(s), ${totalWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({ summary, affected: [], isError: false }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // isolate: highlight specific entities, dim everything else
  // ------------------------------------------------------------------
  if (params.isolate !== undefined) {
    const rawIsolate = params.isolate;
    const ids: string[] = Array.isArray(rawIsolate)
      ? (rawIsolate as string[])
      : typeof rawIsolate === 'string'
        ? [rawIsolate]
        : [];

    let svg = buildIsolateSvg(doc, ids, baseView, baseWidth, baseHeight);
    if (svg === null) {
      return makeErrorResult('render_view isolate: render failed.');
    }

    // Compose overlay enrichments on top
    const baseResult = applyCommand('render_view', { view: baseView, width: baseWidth, height: baseHeight });
    if (params.showDimensions === true && baseResult.data) {
      svg = appendDimensionLabels(svg, baseResult.data as import('@core/commands/render').RenderViewData);
    }
    if ((wantAxes || wantGrid) && baseResult.data) {
      svg = appendAxesAndGrid(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        docUnits,
        wantAxes,
        wantGrid,
      );
    }

    const base64 = rasterizeSvg(svg, baseWidth);
    if (base64 === null) {
      return makeErrorResult('render_view isolate: rasterization failed.');
    }

    const summary = `Rendered isolated view: ${ids.length} entity/entities highlighted, ${baseWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({ summary, affected: [], isError: false }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // section: section-plane view
  // ------------------------------------------------------------------
  if (params.section !== undefined) {
    const { axis, offset } = params.section;
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return makeErrorResult(`render_view section: invalid axis "${String(axis)}". Must be "x", "y", or "z".`);
    }

    let svg = buildSectionSvg(doc, { axis, offset }, baseView, baseWidth, baseHeight);
    if (svg === null) {
      return makeErrorResult('render_view section: render failed.');
    }

    // Compose overlay enrichments on top
    const baseResult = applyCommand('render_view', { view: baseView, width: baseWidth, height: baseHeight });
    if (params.showDimensions === true && baseResult.data) {
      svg = appendDimensionLabels(svg, baseResult.data as import('@core/commands/render').RenderViewData);
    }
    if ((wantAxes || wantGrid) && baseResult.data) {
      svg = appendAxesAndGrid(
        svg,
        baseResult.data as import('@core/commands/render').RenderViewData,
        docUnits,
        wantAxes,
        wantGrid,
      );
    }

    const base64 = rasterizeSvg(svg, baseWidth);
    if (base64 === null) {
      return makeErrorResult('render_view section: rasterization failed.');
    }

    const summary = `Rendered section view: cut at ${axis}=${offset}, ${baseWidth}×${baseHeight}.`;
    const shaped = shapeToolCallContent({ summary, affected: [], isError: false }) as CallToolResult;
    (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
    return shaped;
  }

  // ------------------------------------------------------------------
  // showDimensions / showAxes / showGrid (no other enrichment): base render + post-process
  // ------------------------------------------------------------------
  const busResult = applyCommand('render_view', { view: baseView, width: baseWidth, height: baseHeight });
  if (!busResult.data) {
    return makeErrorResult('render_view enrichment: base render returned no data.');
  }
  const baseData = busResult.data as import('@core/commands/render').RenderViewData;

  let enrichedSvg = baseData.svg;

  if (params.showDimensions === true) {
    enrichedSvg = appendDimensionLabels(enrichedSvg, baseData);
  }
  if (wantAxes || wantGrid) {
    enrichedSvg = appendAxesAndGrid(enrichedSvg, baseData, docUnits, wantAxes, wantGrid);
  }

  const base64 = rasterizeSvg(enrichedSvg, baseWidth);
  if (base64 === null) {
    return makeErrorResult('render_view enrichment: rasterization failed.');
  }

  const summary = `Rendered view: ${baseData.entityCount} entit${baseData.entityCount === 1 ? 'y' : 'ies'}, ${baseWidth}×${baseHeight}.`;
  const shaped = shapeToolCallContent({
    summary,
    affected: [],
    isError: false,
    data: stripSvgFromData(busResult.data),
  }) as CallToolResult;
  (shaped.content as unknown[]).push({ type: 'image', data: base64, mimeType: 'image/png' });
  return shaped;
}

/** Build an error CallToolResult for enrichment failures. */
function makeErrorResult(message: string): CallToolResult {
  return shapeToolCallContent({ summary: message, affected: [], isError: true }) as CallToolResult;
}

/** Extract SVG inner content (strips outer svg tags). Used by enrichment functions. */
function extractSvgInnerPublic(svgString: string): string {
  const openEnd = svgString.indexOf('>');
  if (openEnd === -1) return svgString;
  const closeStart = svgString.lastIndexOf('</svg>');
  if (closeStart === -1) return svgString.substring(openEnd + 1);
  return svgString.substring(openEnd + 1, closeStart);
}

/** Round to 2 decimal places (used in SVG coordinate output). */
function r2Public(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

/**
 * Build a `Server` instance whose handlers are bound to the provided document
 * accessor functions.
 *
 * All sessions share the single live document from `liveDocument.ts`.
 * Mutations route through `commandBus.applyCommand` so every tools/call shares
 * the same undo/redo history as REST /command calls from the browser UI.
 *
 * Each session maintains its own working document for bridge operations:
 *   snapshot_in_from_ui replaces the session working doc from the UI bridge.
 *   snapshot_out_to_ui  stages the session working doc to the UI bridge.
 *
 * @param getDoc - returns the current shared document (used for resources/read)
 * @param bridge - the injected UiBridge for UI↔session sync tools
 */
function buildMcpServer(getDoc: () => CadDocument, bridge: UiBridge): Server {
  const server = new Server(
    { name: 'llull', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Session-level working document for bridge operations.
  // Starts as the shared live doc; snapshot_in_from_ui can replace it.
  let sessionDoc: CadDocument = getDoc();

  // tools/list — return the full registry as MCP tool definitions,
  // with render_view augmented to advertise the server-side enrichment params,
  // plus the two UI bridge tools appended.
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = buildMcpTools().map((t) => {
      if (t.name === 'render_view') {
        // Augment the core render_view schema with server-side enrichment params.
        // The core schema already has: view, width, height.
        // We add: turntable, isolate, showDimensions, section.
        const augmented = {
          ...t.inputSchema,
          properties: {
            ...(t.inputSchema.properties ?? {}),
            turntable: {
              type: 'object',
              description:
                'Produce a horizontal strip of N evenly-spaced rotation frames around the Z (up) axis. ' +
                'frames: integer 1..12. When omitted, behavior is unchanged (single frame).',
              properties: {
                frames: {
                  type: 'number',
                  description: 'Number of frames (1..12). Each frame is a separate rotated view stitched into one wide PNG strip.',
                },
              },
              required: ['frames'],
            },
            isolate: {
              type: 'string',
              description:
                'Entity id (or JSON array of ids) to highlight. All other entities are rendered ' +
                'dimmed/desaturated; the specified id(s) are shown at full color. ' +
                'Pass a single id string or a JSON-encoded array of id strings.',
            },
            showDimensions: {
              type: 'boolean',
              description:
                'When true, overlay the bounding-box dimensions (W × D × H) as text labels on the image. ' +
                'Labels are placed near the bounding box edges in screen space.',
            },
            section: {
              type: 'object',
              description:
                'Render a section-plane view: entities on the negative side of the cut plane are dimmed; ' +
                'a colored dashed line marks the cut. axis: "x"|"y"|"z"; offset: world-space position of the plane.',
              properties: {
                axis: { type: 'string', description: 'Axis normal to the cut plane: "x", "y", or "z".' },
                offset: { type: 'number', description: 'World-space position of the cut plane along the axis.' },
              },
              required: ['axis', 'offset'],
            },
            showAxes: {
              type: 'boolean',
              description:
                'When true (default), overlay a world-frame X/Y/Z axis triad anchored at the world origin. ' +
                'X=red, Y=green, Z=blue. A scale label (e.g. "1 mm = 42 px") is also shown. ' +
                'Set to false to suppress.',
            },
            showGrid: {
              type: 'boolean',
              description:
                'When true (default), overlay a faint ground grid on the Z=0 plane so you can judge ' +
                'object placement relative to the world origin. Set to false to suppress.',
            },
          },
        };
        return {
          name: t.name,
          description:
            t.description +
            ' [Server enrichments available: turntable (multi-frame strip), isolate (highlight entity), ' +
            'showDimensions (bbox labels), section (cut-plane view), showAxes (world triad, default on), ' +
            'showGrid (ground grid, default on).]',
          inputSchema: augmented as {
            type: 'object';
            properties?: Record<string, object>;
            required?: string[];
          },
        };
      }
      return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as {
          type: 'object';
          properties?: Record<string, object>;
          required?: string[];
        },
      };
    });

    // Append the two bridge tools (not in the core registry — bridge-level only).
    const bridgeTools = buildBridgeToolDefinitions().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object';
        properties?: Record<string, object>;
        required?: string[];
      },
      annotations: t.annotations,
    }));

    return { tools: [...tools, ...bridgeTools] };
  });

  // tools/call — route through commandBus so MCP edits share history + broadcast,
  // then shape the result into MCP content blocks via the single implementation
  // in core/mcp (shapeToolCallContent).  execute() runs exactly once (in the bus).
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;

    // -----------------------------------------------------------------------
    // Bridge tool intercept — snapshot_in_from_ui / snapshot_out_to_ui
    // -----------------------------------------------------------------------
    // These tools operate on the per-session working document (sessionDoc) and
    // are NOT routed through the shared command bus — they are bridge-level only.
    const bridgeResult = await applyBridgeToolCall(sessionDoc, name, bridge);
    if (bridgeResult !== null) {
      // snapshot_in_from_ui: update sessionDoc with the UI doc (and also the
      // shared live doc so other sessions and the SSE stream see the new state).
      if (name === 'snapshot_in_from_ui' && bridgeResult.document !== sessionDoc) {
        sessionDoc = bridgeResult.document;
        setLiveDoc(sessionDoc);
      }
      // snapshot_out_to_ui does not change sessionDoc (it only stages a copy).
      // Double cast: BridgeToolResult lacks the SDK's index signature — same
      // pattern as shapeToolCallContent casts throughout this file.
      return bridgeResult as unknown as CallToolResult;
    }

    // -----------------------------------------------------------------------
    // render_view enrichment intercept
    // -----------------------------------------------------------------------
    // When the tool is render_view with server-side enrichment params present,
    // we handle the enrichment here before (or instead of) the normal command
    // bus path.  Enrichment params are stripped before forwarding to applyCommand
    // so the core command never receives unknown params.
    if (name === 'render_view' && args != null) {
      const enrichResult = applyRenderViewEnrichments(args, getDoc);
      if (enrichResult !== null) {
        return enrichResult;
      }
    }

    // -----------------------------------------------------------------------
    // Normal path: route through the command bus
    // -----------------------------------------------------------------------
    // Route through the command bus — runs execute() once, records history for
    // mutations, and broadcasts via setLiveDoc.  Query commands are skipped from
    // history/broadcast (result.data !== undefined, same logic as the UI store).
    const coreArgs = name === 'render_view' ? stripEnrichParams(args ?? {}) : (args ?? {});
    const busResult = applyCommand(name, coreArgs);

    // Keep sessionDoc in sync with the shared live doc after mutations.
    if (busResult.affected.length > 0) {
      sessionDoc = getLiveDoc();
    }

    // Vision loop: rasterize data.svg → PNG image block (if present).
    // Failure is silent (buildImageBlock returns null) so a broken SVG never 500s
    // the tool call; the text/structured content is always returned intact.
    const imageBlock = buildImageBlock(busResult.data);

    // When an image block was produced, strip the raw SVG from the text/structured
    // content shaping input.  The multi-KB <polygon> markup is redundant alongside
    // the PNG — it only burns agent context tokens.  All other metadata fields
    // (bounds, camera, entityCount, width, height, view) are preserved so
    // non-multimodal clients and programmatic agents still receive them.
    // When no image block was produced (normal commands), shapeInput === busResult
    // and behavior is completely unchanged.
    const shapeInput =
      imageBlock !== null ? { ...busResult, data: stripSvgFromData(busResult.data) } : busResult;

    // Delegate all content-block assembly to the single shaping function.
    // Cast: McpShapedResult lacks the SDK Result index signature ([x: string]: unknown)
    // which is a type-system artifact — the runtime shape satisfies CallToolResult.
    const shaped = shapeToolCallContent(shapeInput) as CallToolResult;

    if (imageBlock !== null) {
      // Cast: the SDK's content array type is TextContent|ImageContent|EmbeddedResource
      // but the TypeScript union is exhaustive at compile time; at runtime the MCP
      // spec accepts any object with a valid `type` field. The cast is equivalent to
      // what shapeToolCallContent already does for the whole return value above.
      (shaped.content as unknown[]).push(imageBlock);
    }

    return shaped;
  });

  // resources/list — enumerate the three read-only CAD resources
  server.setRequestHandler(ListResourcesRequestSchema, () => {
    return { resources: listMcpResources() };
  });

  // resources/read — return the requested resource's current content
  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const { uri } = req.params;
    const content = readMcpResource(getDoc(), uri);
    if (content === null) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }
    return { contents: [content] };
  });

  // prompts/list — enumerate registered prompt templates
  server.setRequestHandler(ListPromptsRequestSchema, () => {
    return { prompts: listMcpPrompts() };
  });

  // prompts/get — resolve a prompt template by name, substituting provided args
  server.setRequestHandler(GetPromptRequestSchema, (req): GetPromptResult => {
    const { name, arguments: rawArgs } = req.params;
    const args: Record<string, string> = {};
    if (rawArgs && typeof rawArgs === 'object') {
      for (const [k, v] of Object.entries(rawArgs)) {
        if (typeof v === 'string') args[k] = v;
      }
    }
    const result = getMcpPrompt(name, args);
    if (result === null) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    // McpPromptResult is structurally identical to GetPromptResult (description? + messages[])
    // but lacks the index signature from the SDK's Result base type.
    return result as GetPromptResult;
  });

  return server;
}

// ---------------------------------------------------------------------------
// Session initialisation
// ---------------------------------------------------------------------------

/**
 * Allocate a new MCP session bound to the shared live document.
 *
 * Returns a `{ transport, server }` pair ready to be connected and used for the
 * first `initialize` POST.  The transport's `onsessioninitialized` callback fires
 * once the SDK assigns the session id (during `handleRequest`), at which point
 * the pair is registered in `sessions`.
 *
 * Document access: all sessions share the single live document from `liveDocument.ts`.
 * `getLiveDoc` / `setLiveDoc` are passed as the accessor pair so `buildMcpServer`
 * is unchanged and testable in isolation. Mutations are broadcast to SSE subscribers
 * inside `setLiveDoc`.
 *
 * Cleanup paths (belt-and-suspenders):
 * - `onsessionclosed` fires on explicit HTTP DELETE → removes from `sessions`.
 * - `transport.onclose` fires when the underlying transport closes by ANY path
 *   (client `close()`, dropped socket, crash) → also removes from `sessions`,
 *   preventing unbounded Map growth from clients that never send DELETE.
 */
function allocateSession(bridge: UiBridge): { transport: StreamableHTTPServerTransport; server: Server } {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),

    onsessioninitialized: (sessionId: string): void => {
      sessions.set(sessionId, { transport, lastSeenMs: Date.now() });
    },

    onsessionclosed: (sessionId: string): void => {
      sessions.delete(sessionId);
    },
  });

  // Belt-and-suspenders: also clean up when the transport closes via any path
  // (client disconnect, dropped socket, crash) not covered by onsessionclosed/DELETE.
  // Chain so we don't clobber any handler the SDK may have already set.
  const priorOnClose = transport.onclose;
  transport.onclose = (): void => {
    priorOnClose?.();
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  // Wire the shared live document read accessor and the UI bridge.
  // Mutations route through commandBus.applyCommand (not setLiveDoc directly).
  const server = buildMcpServer(getLiveDoc, bridge);

  return { transport, server };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Build and return the Express Router that mounts the MCP endpoint.
 *
 * Mount in `index.ts` with:
 *   `app.use('/mcp', buildMcpRouter(bridge));`
 *
 * Exposed routes:
 *   POST   /mcp  — MCP Streamable HTTP (initialize + tools/list + tools/call)
 *   GET    /mcp  — SSE stream for server-initiated notifications (MCP spec)
 *   DELETE /mcp  — close session, free its document
 *
 * Session lifecycle:
 *   1. POST without `mcp-session-id` → new session (new UUID + empty document).
 *   2. POST/GET with `mcp-session-id` → route to existing session's transport.
 *   3. DELETE with `mcp-session-id` → SDK calls onsessionclosed → session removed.
 *   4. GET/DELETE without `mcp-session-id` header → 400 (header required).
 *   5. Any request with an unknown session id → 404.
 *
 * @param bridge - the UI↔MCP bridge injected at server startup.
 */
export function buildMcpRouter(bridge: UiBridge): Router {
  // Start the background idle-TTL sweep (no-op if already running).
  startSessionSweep();

  const router = createRouter();
  const auth = buildAuthMiddleware();
  const limiter = buildRateLimiter();

  // Apply auth + rate limit to all MCP routes
  router.use(auth);
  router.use(limiter);

  /**
   * Route a request to an existing session's transport.
   * Returns `true` if the session id header was present (response may be an error).
   * Returns `false` if no session id header — caller handles as a new-session request.
   */
  const routeToExistingSession = async (
    req: Request,
    res: Response,
  ): Promise<boolean> => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId !== 'string') return false;

    const entry = sessions.get(sessionId);
    if (!entry) {
      res.status(404).json({ error: `Unknown or expired session: ${sessionId}` });
      return true; // handled (with error response)
    }

    // Touch the session so the idle-TTL sweep never evicts an active session.
    entry.lastSeenMs = Date.now();

    try {
      await entry.transport.handleRequest(req, res, req.body as unknown);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown MCP error';
      console.error(`[/mcp] session ${sessionId} error:`, msg);
      if (!res.headersSent) {
        res.status(500).json({ error: 'MCP internal error.' });
      }
    }
    return true;
  };

  /**
   * POST handler:
   * - If `mcp-session-id` is present → route to existing session.
   * - Otherwise → allocate a new session (the `initialize` handshake).
   */
  router.post('/', (req: Request, res: Response) => {
    void (async () => {
      // Route to existing session if session id header is present.
      const handled = await routeToExistingSession(req, res);
      if (handled) return;

      // No session id → this is an `initialize` request; allocate a new session.
      const { transport, server } = allocateSession(bridge);

      try {
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res, req.body as unknown);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown MCP error';
        console.error('[/mcp] new session error:', msg);
        // Release the connected transport/server to avoid an orphaned SSE stream
        // or Server instance when initialization fails mid-flight.
        await transport.close().catch(() => {});
        if (!res.headersSent) {
          res.status(500).json({ error: 'MCP internal error.' });
        }
      }
    })();
  });

  /**
   * GET handler — SSE stream for server-initiated notifications.
   * Requires an existing session id (SSE is only valid for live sessions).
   */
  router.get('/', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string') {
        res.status(400).json({ error: 'mcp-session-id header required for GET.' });
        return;
      }
      await routeToExistingSession(req, res);
    })();
  });

  /**
   * DELETE handler — close session and free its document.
   * The SDK's handleDeleteRequest calls onsessionclosed → removes from sessions map.
   */
  router.delete('/', (req: Request, res: Response) => {
    void (async () => {
      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId !== 'string') {
        res.status(400).json({ error: 'mcp-session-id header required for DELETE.' });
        return;
      }
      await routeToExistingSession(req, res);
    })();
  });

  return router;
}
