/** PST-FU2: the stress model's COMPONENT-ATTRIBUTE1..10 (07 PST, CAESAR II import map of 05 `pcf_keywords.json`, grade B) written into the PCF components by `export_pcf`. */

import type { CadDocument } from '@core/model/types';
import { pcfAttributeValues, SLOTS } from '../stress/commands/pcfAttributeSlots';
import { findModel } from '../stress/model/store';
import type { StressModel } from '../stress/model/schema';
import { getPiping } from '../piping/model';
import { legacyLines } from './legacyNetwork';
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
  const entries = SLOTS.flatMap((_, index) => {
    const value = slots[index];
    return value === null || value === undefined ? [] : [[`COMPONENT-ATTRIBUTE${index + 1}`, value] as const];
  });
  return { ok: true, model, attributes: Object.fromEntries(entries) };
}

/** Does the model cover the exported line? `id`: a routed line id or a legacy pipe line key. */
export function modelCoversLine(doc: CadDocument, model: StressModel, kind: 'route' | 'legacy', id: string): boolean {
  const scope = new Set(model.scope.ids);
  if (kind === 'route') {
    const piping = getPiping(doc);
    return model.scope.kind === 'runs' && piping.runOrder.some((runId) => piping.runs[runId]?.lineId === id && scope.has(runId));
  }
  return model.scope.kind === 'pipes' && (legacyLines(doc).get(id) ?? []).some((pipe) => scope.has(pipe.id));
}

/** `components` with the attributes appended to the pipe-borne ones (an attribute a component already holds is kept). */
export function withStressAttributes(
  components: readonly NetworkComponent[],
  attributes: Readonly<Record<string, string>>,
): NetworkComponent[] {
  return components.map((component) =>
    CARRIERS.has(component.type) ? { ...component, extra: { ...attributes, ...component.extra } } : component,
  );
}
