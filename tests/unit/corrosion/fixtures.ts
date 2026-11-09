/** PHY-13 fixtures: the validation pack's plate (100 x 50 x 10) with a 60 x 30 x 5 block resting on it (docs/physics/13-corrosion-compatibility/validation/plans). */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';

export const run = (doc: CadDocument, name: string, params: Record<string, unknown>, ctx?: ExecutionContext): CadDocument => {
  const result = execute(doc, name, params, ctx);
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return result.document;
};

export interface Pair {
  readonly doc: CadDocument;
  readonly plate: string;
  readonly block: string;
}

const SOURCE = { citation: 'PHY-13 galvanic_anodic_index.csv (B)' };

/** Plate and block face to face (1800 mm^2); `groups` = [plate group, block group] get materials `m_plate` / `m_block`. */
export function pair(groups: readonly [string | null, string | null] = [null, null], gap = 0): Pair {
  const first = execute(createEmptyDocument(), 'add_box', { size: [100, 50, 10], anchor: 'min', position: [0, 0, 0] });
  const second = execute(first.document, 'add_box', { size: [60, 30, 5], anchor: 'min', position: [20, 10, 10 + gap] });
  const [plate, block] = [first.affected[0] ?? '', second.affected[0] ?? ''];
  let doc = second.document;
  [plate, block].forEach((id, index) => {
    const name = index === 0 ? 'm_plate' : 'm_block';
    doc = run(doc, 'create_material', { name, density: 0.0028, color: '#cccccc', metalness: 1, roughness: 0.3 });
    doc = run(doc, 'assign_material', { materialName: name, entityIds: [id] });
    const group = groups[index];
    if (group !== null && group !== undefined)
      doc = run(doc, 'set_galvanic_group', { material: name, galvanicGroup: group, source: SOURCE });
  });
  return { doc, plate, block };
}

export const withEnvironment = (doc: CadDocument, environment: string, scheme = 'anodic_index'): CadDocument =>
  run(doc, 'set_service_environment', { scheme, environment });

interface Item {
  key: string;
  status: string;
  code: string;
  ruleId: string;
  ids: string[];
  inputs: Record<string, unknown> & {
    differenceV?: number;
    anode?: string;
    areaRatio?: number;
    anodeAreaMm2?: number;
    cathodeAreaMm2?: number;
  };
  warnings: string[];
  remedies: { id: string }[];
  unverified: boolean;
  reviewRequired: boolean;
  fingerprint: string;
  acceptance?: { decision: string; signer: string };
  staleAcceptance?: boolean;
  contact: { source: string };
}

export interface CheckData {
  status: string;
  scheme: string;
  environment: string;
  items: Item[];
  counts: Record<string, number>;
  text?: string;
  fileName?: string;
}

export const check = (doc: CadDocument, params: Record<string, unknown> = {}, ctx?: ExecutionContext): CheckData =>
  execute(doc, 'check_material_compatibility', params, ctx).data as CheckData;

/** The generator-made oracle of the validation pack. */
export const expected = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/physics/13-corrosion-compatibility/validation/expected_results.json'), 'utf8'),
) as {
  anodicScreening: Record<string, { anode: string; cathode: string; differenceV: number; verdict: Record<string, string> }>;
  cases: { id: string; value: unknown }[];
};
