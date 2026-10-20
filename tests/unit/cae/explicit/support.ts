/** Shared fixtures of the PHY-19 explicit tests: the bar-on-rigid-wall model (VC-EXP-50/67 set-up) and an in-memory artifact store. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { FeArtifactPort } from '@core/model/analysis';
import type { FeExplicitArtifact } from '@core/model/explicit';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';

/** Run a command that must be accepted. */
export function must(doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CommandResult {
  const result = execute(doc, name, params, ctx);
  if (result.error !== undefined) throw new Error(`${name}: ${result.summary}`);
  return result;
}

export const code = (result: CommandResult): string | undefined => result.error?.code;
export const data = <T = Record<string, unknown>>(result: CommandResult): T => result.data as T;

/** Test material (NOT a material claim): E 200 GPa, nu 0.3, 7850 kg/m^3 (validation pack VC-EXP-10). */
const STEEL_LIKE = { E: 200000, nu: 0.3, density: 0.00785 };
const SOURCE = { citation: 'synthetic test input of the PHY-19 validation pack (not a material claim)' };

/** Material `name` with an elastic set; `plastic` adds a Johnson-Cook strength (synthetic constants) and its rate law. */
function withTestMaterial(doc: CadDocument, name: string, plastic = false): CadDocument {
  let next = must(doc, 'create_material', { name, density: STEEL_LIKE.density, color: '#9aa0a6', metalness: 1, roughness: 0.4 }).document;
  const add = (id: string, model: Record<string, unknown>): void => {
    next = must(next, 'add_material_model', { material: name, id, model, basis: 'company', source: SOURCE }).document;
  };
  add('elastic', { kind: 'elastic_isotropic', E: { value: STEEL_LIKE.E, unit: 'MPa' }, nu: { value: STEEL_LIKE.nu, unit: '1' } });
  if (plastic) {
    add('jc', {
      kind: 'j2_plasticity',
      isotropic: {
        kind: 'johnson_cook',
        A: { value: 300, unit: 'MPa' },
        B: { value: 500, unit: 'MPa' },
        n: 0.5,
        m: 1,
        meltTemperature: { value: 1800, unit: 'K' },
        transitionTemperature: { value: 293.15, unit: 'K' },
      },
      kinematic: { kind: 'none' },
    });
    add('jcrate', { kind: 'rate_johnson_cook', C: 0.02, referenceRate: { value: 1, unit: '1/s' } });
  }
  return must(next, 'define_constitutive_set', {
    material: name,
    set: { id: 'set', elastic: 'elastic', ...(plastic ? { plastic: 'jc', rate: 'jcrate' } : {}) },
    makeDefault: true,
  }).document;
}

export interface BarModel {
  readonly doc: CadDocument;
  readonly barId: string;
  readonly analysisId: string;
  readonly wallId: string;
}

/** 10 x 10 x 200 mm steel-like bar at 10 m/s onto a rigid wall at z = 0 (validation plan exp_bar_rigid_wall, structured hex mesh). */
export function barModel(options: { plastic?: boolean; size?: number } = {}): BarModel {
  let doc = must(createEmptyDocument(), 'set_units', { units: 'mm' }).document;
  const bar = must(doc, 'add_box', { size: [10, 10, 200], position: [0, 0, 0], anchor: 'min' });
  const barId = bar.affected[0] ?? '';
  doc = withTestMaterial(bar.document, 'steel_like', options.plastic === true);
  doc = must(doc, 'assign_material', { materialName: 'steel_like', entityIds: [barId] }).document;
  const created = must(doc, 'create_analysis', { name: 'bar_rigid_wall', analysisType: 'explicit_dynamics' });
  const analysisId = created.affected[0] ?? '';
  doc = must(created.document, 'set_part_idealization', { analysisId, entityId: barId }).document;
  doc = must(doc, 'set_explicit_controls', {
    analysisId,
    endTime: { value: 0.00016, unit: 's' },
    historyInterval: { value: 1e-6, unit: 's' },
    mesh: { kind: 'structured_hex', size: options.size ?? 2.5 },
  }).document;
  doc = must(doc, 'set_initial_velocity', { analysisId, entityId: barId, velocity: { vector: [0, 0, -10000], unit: 'mm/s' } }).document;
  const wall = must(doc, 'add_rigid_wall', { analysisId, name: 'anvil', point: [5, 5, 0], normal: [0, 0, 1] });
  return { doc: wall.document, barId, analysisId, wallId: wall.affected[1] ?? '' };
}

/** In-memory artifact store keyed by the sha256 of the canonical JSON, like the host's. */
export function artifactStore(): { readonly port: FeArtifactPort; put(artifact: FeExplicitArtifact): string } {
  const stored = new Map<string, FeExplicitArtifact>();
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

const PLANS = path.resolve(__dirname, '../../../../docs/physics/19-explicit-impact/validation/plans');

/** Replays a validation plan (`{ command, params, as? }` steps, `$alias` = affected[0] of the step named `alias`) on an empty document. */
export function replayPlan(name: string): { readonly doc: CadDocument; readonly aliases: Readonly<Record<string, string>> } {
  const steps = JSON.parse(readFileSync(`${PLANS}/${name}.plan.json`, 'utf8')) as { command: string; params: unknown; as?: string }[];
  const aliases: Record<string, string> = {};
  const substitute = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('$')) return aliases[value.slice(1)] ?? value;
    if (Array.isArray(value)) return value.map(substitute);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry)]));
    return value;
  };
  let doc = createEmptyDocument();
  for (const step of steps) {
    const result = must(doc, step.command, substitute(step.params) as Record<string, unknown>);
    doc = result.document;
    if (step.as !== undefined) aliases[step.as] = result.affected[0] ?? '';
  }
  return { doc, aliases };
}
