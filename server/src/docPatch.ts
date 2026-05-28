/**
 * @layer server
 *
 * Re-exports the canonical DocPatch types and functions from core/mcp.
 *
 * The implementation lives in `src/core/mcp/docPatch.ts` (pure, framework-free).
 * This module is the server's import point so `server/src/liveDocument.ts` imports
 * from a short local path while `src/ui/store` imports from `@core/mcp/docPatch`.
 *
 * Architecture: server → core is allowed (L2 only bars core → server/ui/DOM).
 */

export type { EntityDelta, DocPatch } from '@core/mcp/docPatch';
export { computeDocPatch, applyDocPatch } from '@core/mcp/docPatch';
