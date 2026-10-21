/**
 * Barrel — the public surface of the host protocol package, imported by `server/` (backend + CLI) and tests. Types and
 * helpers used only inside one module stay private to it. Transports (HTTP routes, the CLI) belong in `server/`.
 */

export { buildCommandTools } from './tools';
export { shapeToolCallContent } from './toolResult';
export { redactLicensedOutcome } from './redactLicensed';
export { CONVENTIONS_GUIDE } from './conventions';

export type { CadExchangePort, DwgConverterPort, ProgramRun } from './exchangeTools';
export { buildExchangeToolDefinitions, applyExchangeToolCall, exportStepFile } from './exchangeTools';

export type { FeaToolsPort, FeaHost, FeaToolResult, FieldTableInput, FeaExportFormat, ResultsFileInput } from './feaTools';
export { buildFeaToolDefinitions, FEA_SOLVE_TIMEOUT_S } from './feaTools';
export { buildLibraryToolDefinitions, type MaterialLibraryStorePort, type LibraryRegistration } from './libraryTools';
export { buildNativeToolDefinitions } from './nativeTools';

export { buildAllTools, searchTools } from './discovery';

export type { ToolsetName } from './toolsets';
export { TOOLSET_NAMES, TOOLSETS, isToolsetName, toolsetOf } from './toolsets';
