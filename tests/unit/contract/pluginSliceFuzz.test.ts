/**
 * Every plugin that owns a document slice survives a hostile file: for seeded mutations of its slice (deleted keys, swapped types, non-finite /
 * negative / huge numbers, reserved keys, duplicate ids, dangling references, long strings and arrays) the REAL load path (`load_document`)
 * never throws and either refuses the file with a value-validation summary, or accepts it and then the loaded document re-saves to the same
 * text, re-reconciles, and runs one query and one mutating command of the plugin without throwing.
 *
 * A plugin with a `document` extension and no row in tests/helpers/pluginSliceSeeds.ts fails here by name. A defect that is too large to fix in
 * place goes in KNOWN_FINDINGS below (commented, with the failing case): the test asserts it STILL fails, so a fix forces its removal.
 */

import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { derivedEntityIds, documentExtensions, onPluginInstalled } from '@core/plugins/host';
import { hasRoot, NON_JSON_KINDS, sampleMutations, type SliceMutation } from '../../helpers/sliceMutations';
import { SLICE_SEEDS, type PluginSliceSeed } from '../../helpers/pluginSliceSeeds';

const CASES_PER_PLUGIN = Number(process.env['FUZZ_CASES'] ?? 36);
const CASE_BUDGET_MS = 3_000;
const REFUSAL = 'load_document: document contains invalid values';

/**
 * Known defects, `plugin | case label` -> what goes wrong. Each is asserted to still fail (ratchet): fix it, then delete the line.
 */
const KNOWN_FINDINGS: Readonly<Record<string, string>> = {};

const pluginsWithSlice: string[] = [];
onPluginInstalled((plugin) => {
  if (plugin.document !== undefined) pluginsWithSlice.push(plugin.name);
});

const describeError = (error: unknown): string =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300);

/** Runs `step`; a throw becomes a finding (`what` names the property that broke). */
function guarded(findings: string[], label: string, what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    findings.push(`${label}: ${what} threw ${describeError(error)}`);
  }
}

function acceptedProperties(findings: string[], label: string, seed: PluginSliceSeed, loaded: CadDocument): void {
  guarded(findings, label, 'round trip', () => {
    const saved = serializeDocument(loaded);
    const again = serializeDocument(deserializeDocument(saved));
    if (again !== saved) findings.push(`${label}: save -> load -> save is not equal`);
  });
  guarded(findings, label, 'derivedEntityIds', () => void derivedEntityIds(loaded));
  for (const extension of documentExtensions()) {
    guarded(findings, label, 'reconcile', () => void extension.reconcile?.(loaded, loaded));
    guarded(findings, label, 'afterLoad', () => void extension.afterLoad?.(loaded));
  }
  const ctx = seed.ctx?.();
  for (const command of [seed.query, seed.mutate]) {
    if (command === undefined) continue;
    guarded(findings, label, command.name, () => {
      const result = execute(loaded, command.name, command.params(loaded), ctx);
      if (result.error?.code === 'CMD_THREW')
        findings.push(`${label}: ${command.name} threw inside execute: ${result.summary.slice(0, 300)}`);
      if (result.document !== loaded && result.rejected !== true && result.error === undefined)
        guarded(findings, label, `${command.name} output reload`, () => void deserializeDocument(serializeDocument(result.document)));
    });
  }
}

function runMutation(plugin: string, seed: PluginSliceSeed, raw: Record<string, unknown>, mutation: SliceMutation): string[] {
  const label = `${plugin} | ${mutation.label}`;
  const findings: string[] = [];
  if (process.env['FUZZ_TRACE'] !== undefined)
    appendFileSync(
      process.env['FUZZ_TRACE'],
      `${label}
`,
    );
  const started = performance.now();
  const mutated = mutation.apply(raw);
  if (NON_JSON_KINDS.has(mutation.kind)) {
    for (const extension of documentExtensions()) {
      guarded(findings, label, 'validate (non-finite number)', () => void extension.validate(mutated));
      guarded(findings, label, 'restore (non-finite number)', () => void extension.restore(mutated));
    }
  } else {
    const json = JSON.stringify({ format: 'llull-document', version: 3, document: mutated });
    const empty = createEmptyDocument();
    let result;
    try {
      result = execute(empty, 'load_document', { json });
    } catch (error) {
      findings.push(`${label}: load_document threw ${describeError(error)}`);
    }
    if (result !== undefined && result.document === empty) {
      if (!result.summary.includes(REFUSAL))
        findings.push(`${label}: refused without a validation summary: ${result.summary.slice(0, 300)}`);
    } else if (result !== undefined) acceptedProperties(findings, label, seed, result.document);
  }
  const elapsed = performance.now() - started;
  if (process.env['FUZZ_TIMING'] !== undefined && elapsed > 300) console.warn(`SLOW ${Math.round(elapsed)} ms ${label}`);
  if (elapsed > CASE_BUDGET_MS) findings.push(`${label}: took ${Math.round(elapsed)} ms (budget ${CASE_BUDGET_MS} ms)`);
  return findings;
}

describe('plugin document slices under hostile files', () => {
  it('every plugin with a document extension has a seed', () => {
    const missing = pluginsWithSlice.filter((name) => SLICE_SEEDS[name] === undefined);
    expect(missing, `add a seed row in tests/helpers/pluginSliceSeeds.ts for: ${missing.join(', ')}`).toEqual([]);
    const stale = Object.keys(SLICE_SEEDS).filter((name) => !pluginsWithSlice.includes(name));
    expect(stale, 'seed rows of plugins that are not installed or have no document extension').toEqual([]);
  });

  describe.each(Object.keys(SLICE_SEEDS).filter((name) => process.env['FUZZ_ONLY'] === undefined || name === process.env['FUZZ_ONLY']))(
    '%s',
    (plugin) => {
      it('keeps load_document total over mutations of its slice', { timeout: 120_000 }, () => {
        const seed = SLICE_SEEDS[plugin] as PluginSliceSeed;
        const document = seed.build();
        const raw = (JSON.parse(serializeDocument(document)) as { document: Record<string, unknown> }).document;
        for (const root of seed.roots) expect(hasRoot(raw, root), `seed of '${plugin}' has no slice at '${root}'`).toBe(true);
        const loaded = execute(createEmptyDocument(), 'load_document', { json: serializeDocument(document) });
        expect(loaded.summary, `the unmutated seed of '${plugin}' must load`).toMatch(/^Loaded document/);

        const mutations = sampleMutations(raw, seed.roots, plugin, CASES_PER_PLUGIN);
        expect(mutations.length, `no mutation could be drawn from the slice of '${plugin}'`).toBeGreaterThan(10);
        const findings = mutations.flatMap((mutation) => runMutation(plugin, seed, raw, mutation));

        const known = Object.keys(KNOWN_FINDINGS).filter((key) => key.startsWith(`${plugin} | `));
        const unexpected = findings.filter((finding) => !known.some((key) => finding.startsWith(`${key}:`)));
        const fixed = known.filter((key) => !findings.some((finding) => finding.startsWith(`${key}:`)));
        expect(fixed, 'known finding no longer fails: delete it from KNOWN_FINDINGS').toEqual([]);
        expect(unexpected).toEqual([]);
      });
    },
  );
});
