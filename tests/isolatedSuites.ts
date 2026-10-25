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
  'tests/unit/plant/piping/convertReplaceGuard.test.ts',
  'tests/unit/contract/entityPropertiesPort.test.ts',
  'tests/unit/contract/plugins.test.ts',
  'tests/unit/contract/reconcile.test.ts',
  'tests/unit/contract/retiredCommands.test.ts',
  'tests/unit/contract/reviewFixes.test.ts',
  'tests/unit/physics/thermal/viewFactorReciprocity.test.ts',
];

/**
 * DOM suites (vite.config.ts `dom-isolated` project) that keep a fresh jsdom module graph per file; every other DOM suite shares one per
 * worker (`dom` project, isolate: false, tests/setupDom.ts resets the stores, storage and renders between tests). A suite belongs here when
 * it calls vi.mock / vi.doMock / vi.stubGlobal / vi.stubEnv / vi.resetModules, registers test-only commands or swaps a module-level law.
 * tests/unit/contract/isolatedSuites.test.ts keeps this list complete.
 */
export const DOM_ISOLATED_SUITES: readonly string[] = [
  'tests/component/AnalysisOnModel.test.tsx',
  'tests/component/AnalysisPanel.test.tsx',
  'tests/component/AnalysisRest.test.tsx',
  'tests/component/BoxSelectEscape.test.tsx',
  'tests/component/BuildingElementInspector.test.tsx',
  'tests/component/BuildingProductionForms.test.tsx',
  'tests/component/CivilCrsSheets.test.tsx',
  'tests/component/CivilDesignControls.test.tsx',
  'tests/component/CivilPanel.test.tsx',
  'tests/component/DrawInteractionTap.test.tsx',
  'tests/component/EmptyState.test.tsx',
  'tests/component/EntitiesMemo.test.tsx',
  'tests/component/ExchangePanel.test.tsx',
  'tests/component/FreeformEditing.test.tsx',
  'tests/component/LiveFx.test.tsx',
  'tests/component/ModelExport.test.tsx',
  'tests/component/NamedViews.test.tsx',
  'tests/component/PmiPanel.test.tsx',
  'tests/component/ReportIssueDialog.test.tsx',
  'tests/component/ReviewDisposition.test.tsx',
  'tests/component/SolidMeshShell.test.tsx',
  'tests/component/SpaceMouseControl.test.tsx',
  'tests/component/TextRenderer2DMinSize.test.tsx',
  'tests/component/TopologyPanel.test.tsx',
  'tests/component/ViewPresets.test.tsx',
  'tests/component/uiPreferences.test.ts',
  'tests/component/useLiveDocument.test.tsx',
  'tests/integration/dispatchOnResult.test.ts',
  'tests/integration/dispatchSelectAffected.test.ts',
  'tests/integration/store.test.ts',
  'tests/integration/undo.test.ts',
];
