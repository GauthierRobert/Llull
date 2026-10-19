/** Shared fixtures of the PHY-17 topology tests: the MBB validation plan, an in-memory artifact store and the host-transport steps. */
import { readFileSync } from 'node:fs';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort } from '@core/model/analysis';
import type { FeTopologyArtifact, TopologyStudy } from '@core/model/topology';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { buildTopologyJob, runTopologyReference, type TopologyJob } from '@cae/index';

const PACK = 'docs/physics/17-topology-optimization/validation';

export interface PlanAction {
  command: string;
  params: Record<string, unknown>;
  as?: string;
}

export const readPlan = (name: string): PlanAction[] => JSON.parse(readFileSync(`${PACK}/plans/${name}.plan.json`, 'utf8')) as PlanAction[];

export const data = <T = Record<string, unknown>>(result: CommandResult): T => result.data as T;
export const code = (result: CommandResult): string | undefined => result.error?.code;

/** In-memory artifact store keyed by the sha256 of the canonical JSON, like the host's. */
export function artifactStore(): { readonly port: FeArtifactPort; put(artifact: FeTopologyArtifact): string } {
  const stored = new Map<string, FeTopologyArtifact>();
  return {
    port: { get: (hash) => stored.get(hash) ?? null },
    put: (artifact) => {
      const hash = sha256Hex(canonicalJson(artifact));
      stored.set(hash, artifact);
      return hash;
    },
  };
}

export const contextWith = (port: FeArtifactPort | null): ExecutionContext => ({ ...defaultContext(), feaArtifacts: port });

/** The plan idealises the plate as plane_stress, which 05 does not build yet (FEA_IDEALIZATION_UNSUPPORTED): use the solid idealization, the thickness is the box depth. */
const solidIdealization = (action: PlanAction): PlanAction =>
  action.command === 'set_part_idealization'
    ? { ...action, params: { analysisId: action.params['analysisId'], entityId: action.params['entityId'], idealization: 'solid' } }
    : action;

export interface Model {
  readonly doc: CadDocument;
  readonly entityId: string;
  readonly analysisId: string;
  readonly studyId: string;
}

/** The MBB plan up to (and including) the study, `filter` replacing the plan's; extra `settings` are applied after it. */
export function mbbModel(settings: Record<string, unknown> = {}, edit?: (action: PlanAction) => PlanAction): Model {
  const actions = readPlan('top_mbb_60x20')
    .map(solidIdealization)
    .map((action) => (edit === undefined ? action : edit(action)));
  const built = execute(createEmptyDocument(), 'build_project', { actions });
  const steps = (built.data as { steps: Array<{ ok: boolean; command: string; summary: string }> }).steps;
  const failed = steps.filter((step) => !step.ok);
  if (failed.length > 0) throw new Error(`plan failed: ${failed.map((step) => `${step.command}: ${step.summary}`).join(' | ')}`);
  let doc = built.document;
  const analysis = doc.analysis;
  const analysisId = analysis?.caseOrder[0] ?? '';
  const studyId = analysis?.cases[analysisId]?.topologyOrder?.[0] ?? '';
  if (Object.keys(settings).length > 0) doc = execute(doc, 'set_topology_settings', { studyId, ...settings }).document;
  const entityId = Object.keys(doc.entities).find((id) => doc.entities[id]?.kind === 'box') ?? '';
  return { doc, entityId, analysisId, studyId };
}

export const studyOf = (doc: CadDocument, analysisId: string, studyId: string): TopologyStudy => {
  const study = doc.analysis?.cases[analysisId]?.topology?.[studyId];
  if (study === undefined) throw new Error(`no study ${studyId}`);
  return study;
};

export function jobOf(model: Model): TopologyJob {
  const built = buildTopologyJob(model.doc, studyOf(model.doc, model.analysisId, model.studyId));
  if (!built.ok) throw new Error(`${built.code}: ${built.message}`);
  return built.job;
}

/** The host's steps for a small 2D study: build the job, run the TypeScript reference, store the artifact, record it. */
export function solveAndRecord(
  model: Model,
  store = artifactStore(),
): {
  readonly doc: CadDocument;
  readonly hash: string;
  readonly artifact: FeTopologyArtifact;
  readonly store: ReturnType<typeof artifactStore>;
  readonly result: CommandResult;
} {
  const artifact = runTopologyReference(jobOf(model));
  if (typeof artifact === 'string') throw new Error(artifact);
  const hash = store.put(artifact);
  const result = execute(model.doc, 'record_topology_result', { studyId: model.studyId, fieldHash: hash }, contextWith(store.port));
  return { doc: result.document, hash, artifact, store, result };
}
