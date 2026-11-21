/** PST-FU2: the stress model's COMPONENT-ATTRIBUTE1..10 (07 PST, CAESAR II import map of 05 `pcf_keywords.json`, grade B) written into the PCF components by `export_pcf`. */

import type { CadDocument } from '@core/model/types';
import { pcfAttributeValues } from '../stress/commands/pcfAttributeSlots';
import { findModel } from '../stress/model/store';
import type { StressModel } from '../stress/model/schema';
import type { NetworkComponent, PcfComponentType } from './model';

/** Components that carry the attributes: the pipe-borne ones; SUPPORT, WELD, BOLT and GASKET stay as they are. */
const CARRIERS: ReadonlySet<PcfComponentType> = new Set([
  'PIPE',
  'ELBOW',
  'BEND',
  'TEE',
  'OLET',
  'REDUCER-CONCENTRIC',
  'REDUCER-ECCENTRIC',
  'FLANGE',
  'FLANGE-BLIND',
  'VALVE',
  'CAP',
  'INSTRUMENT',
]);

export type StressAttributes =
  | { readonly ok: true; readonly model: StressModel; readonly attributes: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

/** The present slots of model `modelId` as `COMPONENT-ATTRIBUTE<n>` -> value, or the reason it cannot be written. */
export function stressAttributesOf(doc: CadDocument, modelId: string): StressAttributes {
  const model = findModel(doc, modelId);
  if (model === undefined) return { ok: false, reason: `no stress model "${modelId}"` };
  if (model.conditions === undefined) return { ok: false, reason: `stress model ${modelId} has no operating conditions` };
  const { slots } = pcfAttributeValues(model.conditions);
  const entries = slots.flatMap((value, index) => (value === null ? [] : [[`COMPONENT-ATTRIBUTE${index + 1}`, value] as const]));
  return { ok: true, model, attributes: Object.fromEntries(entries) };
}

export interface Applied {
  readonly components: NetworkComponent[];
  /** Scope ids (run ids / pipe ids) whose components got the attributes. */
  readonly applied: string[];
  /** Pipe-borne components of the line that belong to something outside the model scope (they are left as they are). */
  readonly skipped: number;
}

/** The run / pipe a component belongs to: the part of its id before the first `/` (`run-6.1/pipe-2`, `pipe-3/elbow-1`). */
const ownerOf = (component: NetworkComponent): string => component.id.split('/')[0] as string;

/**
 * `components` with the attributes appended to the pipe-borne components of the model scope (an attribute a component already holds is kept);
 * `kind` is the kind of line (routed lines are covered by run-scoped models, legacy lines by pipe-scoped ones).
 */
export function withStressAttributes(
  components: readonly NetworkComponent[],
  attributes: Readonly<Record<string, string>>,
  model: StressModel,
  kind: 'route' | 'legacy',
): Applied {
  const scope = new Set(model.scope.kind === (kind === 'route' ? 'runs' : 'pipes') ? model.scope.ids : []);
  const applied = new Set<string>();
  let skipped = 0;
  const out = components.map((component) => {
    if (!CARRIERS.has(component.type)) return component;
    const owner = ownerOf(component);
    if (!scope.has(owner)) {
      skipped += 1;
      return component;
    }
    applied.add(owner);
    return { ...component, extra: { ...attributes, ...component.extra } };
  });
  return { components: out, applied: [...applied].sort(), skipped };
}
