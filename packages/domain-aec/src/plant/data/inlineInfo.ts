/** Valves and reducers of the routed runs with what the derivation says about them (plant 08 DAT M5): the facts the `inlineComponent` provider and the valve list read. */

import type { CadDocument } from '@core/model/types';
import type { InlineComponent, PipeRun } from '../types';
import { getPiping } from '../piping/model';
import { deriveRun } from '../piping/routeParts';

export interface InlineInfo {
  readonly component: InlineComponent;
  readonly run: PipeRun;
  /** Line number of the piping line of the run. */
  readonly lineNumber: string;
  readonly spec: string;
  /** Size entering the component and its face-to-face length (mm) from the derived run; null when the run no longer derives. */
  readonly dn: number | null;
  readonly lengthMm: number | null;
  readonly unverified: boolean;
}

export const isValveType = (type: string): boolean => type.startsWith('valve');

function infosOfRun(doc: CadDocument, run: PipeRun): InlineInfo[] {
  const inline = run.inline ?? [];
  if (inline.length === 0) return [];
  const line = getPiping(doc).lines[run.lineId];
  const derived = deriveRun(doc, run);
  return inline.map((component) => {
    const placed = derived.ok ? derived.inline.find((item) => item.id === component.id) : undefined;
    return {
      component,
      run,
      lineNumber: line?.lineNumber ?? run.lineId,
      spec: line?.spec ?? '',
      dn: placed?.dn ?? null,
      lengthMm: placed?.lengthMm ?? null,
      unverified: derived.ok ? derived.unverified : true,
    };
  });
}

/** Every inline component of the document, in run order. */
export function inlineInfos(doc: CadDocument): InlineInfo[] {
  const piping = getPiping(doc);
  return piping.runOrder.flatMap((runId) => {
    const run = piping.runs[runId];
    return run === undefined ? [] : infosOfRun(doc, run);
  });
}

export function inlineInfoOf(doc: CadDocument, id: string): InlineInfo | undefined {
  const piping = getPiping(doc);
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    if (run?.inline?.some((component) => component.id === id) === true)
      return infosOfRun(doc, run).find((info) => info.component.id === id);
  }
  return undefined;
}
