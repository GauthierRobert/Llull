/**
 * Unit suites that need a fresh jsdom module graph per file (vite.config.ts `isolated` project); every other
 * `tests/unit` / `tests/golden` suite shares one module graph per worker (`node` project, isolate: false).
 * A suite belongs here when it calls vi.mock / vi.doMock / vi.stubGlobal / vi.stubEnv / vi.resetModules, touches
 * DOM globals (window, localStorage), registers test-only commands (registerCommands, installPlugin), or swaps a module-level law
 * (setEngineLossLaw / setRealismLaw).
 * tests/unit/contract/isolatedSuites.test.ts keeps this list complete.
 */
export const ISOLATED_SUITES: readonly string[] = [
  'tests/unit/commandContract.test.ts',
  'tests/unit/engineInjection.test.ts',
  'tests/unit/historyWithoutRegistry.test.ts',
  'tests/unit/layoutStore.test.ts',
  'tests/unit/manifoldKernelLeaks.test.ts',
  'tests/unit/projectStepData.test.ts',
  'tests/unit/serverConfig.test.ts',
  'tests/unit/serverFiles.test.ts',
  'tests/unit/cae/ports.test.ts',
  'tests/unit/contract/entityPropertiesPort.test.ts',
  'tests/unit/contract/plugins.test.ts',
  'tests/unit/contract/retiredCommands.test.ts',
  'tests/unit/contract/reviewFixes.test.ts',
  'tests/unit/physics/thermal/viewFactorReciprocity.test.ts',
];
