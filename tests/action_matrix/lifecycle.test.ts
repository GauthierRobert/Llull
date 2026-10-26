/**
 * Document-lifecycle contract (SC-Q2 extension): for every design of the corpus (PR sample or full, like the action matrix) and for the
 * document after a few `ok` actions: save/load, replay, undo/redo, deletion, clear_document and id hygiene (tests/action_matrix/lifecycleChecks.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, getGeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { setSignaturePort } from '@core/commands/signaturePort';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import type { CadDocument } from '@core/model/types';
import { readConfig } from './config';
import {
  type LifecycleFinding,
  checkAfterDelete,
  checkClear,
  checkIdHygiene,
  checkReplay,
  checkRoundTrip,
  checkUndoRedo,
  deletions,
  withLifecycleContext,
} from './lifecycleChecks';
import { type LifecycleDesign, lifecycleDesigns, uncoveredPlugins } from './lifecycleCorpus';
import { KNOWN_LIFECYCLE_FINDINGS } from './lifecycleKnown';
import { sampled, stableHash } from './stableHash';

const config = readConfig('manifold');
const SEED = config.options.seed;
const LIMITS = config.full
  ? { actions: 8, entities: 4, definitions: 30, perTool: 2 }
  : { actions: 2, entities: 2, definitions: 12, perTool: 1 };

let previous: GeometryKernel | null;
beforeAll(async () => {
  previous = getGeometryKernel();
  setGeometryKernel(await createManifoldKernel());
  // plm plans confirm signatures through a scripted port (as tests/golden/golden.test.ts does).
  setSignaturePort({
    verify: (c) =>
      typeof c === 'object' && c !== null && 'as' in c ? { signer: String((c as { as: unknown }).as), signatureId: 'lifecycle' } : null,
  });
}, 60_000);
afterAll(() => {
  setSignaturePort(null);
  setGeometryKernel(previous);
});

const designs = lifecycleDesigns();

/** PR mode: 1-in-N designs plus every plugin seed document (cheap, and the only design of some plugins); full mode: all. */
function chosenDesigns(): LifecycleDesign[] {
  if (config.full) return designs;
  return designs.filter((design) => design.id.startsWith('seed/') || sampled(design.id, config.options.designSample, SEED));
}

function actionSteps(doc: CadDocument): { command: string; params: Record<string, unknown> }[] {
  const steps: { command: string; params: Record<string, unknown> }[] = [];
  for (const id of doc.order.slice(0, 3)) {
    steps.push({ command: 'move_entities', params: { ids: [id], delta: [5, 0, 0] } });
    steps.push({ command: 'rotate_entity', params: { id, delta: [0, 0, 0.3] } });
    steps.push({ command: 'mirror_entity', params: { id, axis: 'x' } });
    steps.push({ command: 'array_linear', params: { id, count: 3, offset: [20, 0, 0] } });
  }
  return steps.sort((a, b) => stableHash(JSON.stringify(a), SEED) - stableHash(JSON.stringify(b), SEED));
}

function lifecycleFindings(design: LifecycleDesign): LifecycleFinding[] {
  const doc = design.build();
  if (doc === null) return [];
  const findings: LifecycleFinding[] = [];
  const add = (found: readonly LifecycleFinding[]): void => void findings.push(...found);
  add(checkRoundTrip(doc, 'design'));
  add(checkReplay(doc, 'design'));
  add(checkIdHygiene(doc, 'design'));
  add(checkClear(doc, 'design'));
  const steps = actionSteps(doc);
  let taken = 0;
  for (const step of steps) {
    if (taken >= LIMITS.actions) break;
    const result = execute(doc, step.command, step.params);
    if (result.document === doc || result.affected.length === 0) continue;
    taken++;
    const target = `${step.command}:${String(step.params['id'] ?? (step.params['ids'] as string[])[0])}`;
    add(checkRoundTrip(result.document, target));
    add(checkReplay(result.document, target));
    add(checkIdHygiene(result.document, target));
  }
  add(checkUndoRedo(doc, steps.slice(0, LIMITS.actions * 2), 'actions'));
  for (const attempt of deletions(doc, LIMITS.entities, LIMITS.definitions, LIMITS.perTool, SEED))
    add(checkAfterDelete(doc, attempt.after, `${attempt.command}:${attempt.id}`, attempt.id));
  return findings.map((finding) => ({ ...finding, key: `${design.id}|${finding.key}` }));
}

describe('document lifecycle contract', () => {
  it('has a design for every plugin with a document extension', () => {
    expect(uncoveredPlugins(designs)).toEqual([]);
  });

  const chosen = chosenDesigns();
  for (const design of chosen) {
    it(`${design.id} keeps its state through save, replay, undo, delete and clear`, () => {
      const warn = console.warn;
      console.warn = () => undefined;
      let findings: LifecycleFinding[];
      try {
        findings = withLifecycleContext(design.context?.(), () => lifecycleFindings(design));
      } finally {
        console.warn = warn;
      }
      const unexpected = findings.filter((finding) => !(finding.key in KNOWN_LIFECYCLE_FINDINGS));
      expect(unexpected.map((finding) => `${finding.key}: ${finding.detail}`)).toEqual([]);
      if (config.full) {
        const seen = new Set(findings.map((finding) => finding.key));
        const stale = Object.keys(KNOWN_LIFECYCLE_FINDINGS).filter((key) => key.startsWith(`${design.id}|`) && !seen.has(key));
        expect(stale).toEqual([]);
      }
    }, 120_000);
  }
});
